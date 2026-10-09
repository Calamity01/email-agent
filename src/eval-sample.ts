import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { graph } from './graph.js';
import { classifyEmail } from './classify.js';
import { CATEGORIES, categoryIds } from './taxonomy.js';
import { PREFER, assertMailbox, toEmailInput, type InboxMessage } from './mail.js';
import { parseCsv, toCsv } from './csv.js';

const OUT = 'eval';

type Meta = {
  id: string;
  subject: string | null;
  from?: { emailAddress?: { address?: string } };
  receivedDateTime: string;
  webLink?: string;
};

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** Identifiants des courriels déjà tirés dans d'autres échantillons (--exclude run1,run2). */
async function excludedIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const t of arg('exclude', '').split(',').filter(Boolean)) {
    const [head, ...rows] = parseCsv(await fs.readFile(`${OUT}/${t}.to-label.csv`, 'utf8'));
    const i = head.indexOf('id');
    for (const r of rows) if (r[i]) ids.add(r[i]);
  }
  return ids;
}

/** Liste les métadonnées (sans les corps) de tout le dossier Archive, avec cache local. */
async function listArchive(): Promise<Meta[]> {
  const cache = `${OUT}/archive-index.json`;
  if (!process.argv.includes('--refresh')) {
    try {
      return JSON.parse(await fs.readFile(cache, 'utf8'));
    } catch { /* pas de cache */ }
  }
  const all: Meta[] = [];
  let url: string | undefined =
    '/me/mailFolders/archive/messages?$select=id,subject,from,receivedDateTime,webLink' +
    `&$orderby=${encodeURIComponent('receivedDateTime desc')}&$top=100`;
  while (url) {
    const page: { value: Meta[]; '@odata.nextLink'?: string } = await graph(url, {
      headers: { Prefer: PREFER },
    });
    all.push(...page.value);
    url = page['@odata.nextLink'];
    process.stdout.write(`\rIndexation de l'archive : ${all.length} messages`);
  }
  process.stdout.write('\n');
  await fs.writeFile(cache, JSON.stringify(all));
  return all;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(items: T[], n: number, seed: number): T[] {
  const rng = mulberry32(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

async function main() {
  const n = Number(arg('n', '150'));
  const seed = Number(arg('seed', '42'));
  const tag = arg('tag', 'run1');
  const noClassify = process.argv.includes('--no-classify');
  const labelFile = `${OUT}/${tag}.to-label.csv`;
  const agentFile = `${OUT}/${tag}.agent.jsonl`;

  await fs.mkdir(OUT, { recursive: true });
  // Garde-fou : ne jamais écraser un fichier que tu as peut-être déjà étiqueté
  for (const f of noClassify ? [labelFile] : [labelFile, agentFile]) {
    const exists = await fs.access(f).then(() => true, () => false);
    if (exists) throw new Error(`${f} existe déjà. Utilise --tag autre_nom pour un nouvel échantillon.`);
  }

  const excluded = await excludedIds();
  const me = await assertMailbox();
  const index = await listArchive();

  const exclude = process.env.EXCLUDE_REGEX ? new RegExp(process.env.EXCLUDE_REGEX, 'i') : null;
  const eligible = index.filter((m) => {
    const from = m.from?.emailAddress?.address?.toLowerCase() ?? '';
    if (from === me) return false; // messages que tu as toi-même écrits
    if (exclude?.test(`${from} ${m.subject ?? ''}`)) return false;
    if (excluded.has(m.id)) return false; // déjà tiré dans un autre échantillon
    return true;
  });
  console.log(`${index.length} messages dans Archive, ${eligible.length} admissibles. Échantillon : ${n}.`);

  const picked = sample(eligible, n, seed);
  let done = 0;

  const rows = await pool(picked, 4, async (meta) => {
    try {
      const full = await graph<InboxMessage>(
        `/me/messages/${encodeURIComponent(meta.id)}` +
        '?$select=id,subject,from,receivedDateTime,conversationId,body',
        { headers: { Prefer: PREFER } },
      );
      const input = toEmailInput(full);
      const classification = noClassify ? undefined : await classifyEmail(input);
      process.stdout.write(`\r${++done}/${picked.length}`);
      return { meta, input, classification, error: undefined as string | undefined };
    } catch (e) {
      process.stdout.write(`\r${++done}/${picked.length}`);
      return {
        meta,
        input: undefined,
        classification: undefined,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
  process.stdout.write('\n');

  // Extrait : le message récent ; s'il est très court (ex. un transfert), on ajoute le début de l'historique
  const excerpt = (input?: { bodyText: string; quotedText?: string }) => {
    if (!input) return '';
    const text =
      input.bodyText.length >= 40
        ? input.bodyText
        : `${input.bodyText} [historique] ${input.quotedText ?? ''}`;
    return text.replace(/\s+/g, ' ').slice(0, 300);
  };

  // Fichier à étiqueter : AUCUNE catégorie de l'agent
  const header = ['id', 'date', 'de', 'objet', 'extrait', 'lien', 'ma_categorie', 'ref_commande'];
  const labelRows = rows.map((r) => [
    r.meta.id,
    r.meta.receivedDateTime.slice(0, 10),
    r.meta.from?.emailAddress?.address ?? '',
    r.meta.subject ?? '',
    excerpt(r.input),
    r.meta.webLink ?? '',
    '', // ma_categorie
    '', // ref_commande (optionnel : numéro de commande, pour les suivis)
  ]);
  await fs.writeFile(labelFile, toCsv([header, ...labelRows]));

  // Résultats de l'agent : seulement si on a classifié
  if (!noClassify) {
    await fs.writeFile(
      agentFile,
      rows
        .map((r) => JSON.stringify({ id: r.meta.id, classification: r.classification, error: r.error }))
        .join('\n') + '\n',
    );
  }

  const failed = rows.filter((r) => r.error).length;
  console.log(`\nÉchantillon écrit : ${labelFile}`);
  if (!noClassify) console.log(`Résultats de l'agent : ${agentFile}`);
  if (failed) console.log(`${failed} courriels n'ont pas pu être lus ou classifiés.`);
  console.log('\nCatégories actives pour la colonne ma_categorie (laisse vide pour « autre » avec --blank-autre) :');
  for (const id of categoryIds) console.log(`  ${id}  (${CATEGORIES[id].label})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});