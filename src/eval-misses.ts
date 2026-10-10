import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { graph } from './graph.js';
import { PREFER, assertMailbox } from './mail.js';
import { CATEGORIES, toActive, type Category, type Classification } from './taxonomy.js';
import { finalCategory } from './rules.js';
import { parseCsv } from './csv.js';

const norm = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
const byName = new Map<string, Category>();
for (const [id, c] of Object.entries(CATEGORIES)) {
  byName.set(norm(id), id as Category);
  byName.set(norm(c.label), id as Category);
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

type R = { id: string; truth: Category; pred: Category; subject: string; atts: string[] };

async function main() {
  const tag = arg('tag', 'run3');
  const run = arg('run', 'final');
  const me = await assertMailbox();

  const [head, ...rows] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const col = (n: string) => head.indexOf(n);
  const [cId, cFrom, cSubj, cMine] = ['id', 'de', 'objet', 'ma_categorie'].map(col);

  const agent = new Map<string, Classification>();
  for (const line of (await fs.readFile(`eval/${tag}.agent.${run}.jsonl`, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.classification) agent.set(r.id, r.classification);
  }
  const recipients: Record<string, { to: string[]; cc: string[] }> = JSON.parse(
    await fs.readFile(`eval/${tag}.recipients.json`, 'utf8'),
  );

  // Noms des pièces jointes (hors images de signature), avec cache local
  const cacheFile = `eval/${tag}.attachments.json`;
  let cache: Record<string, string[]> = {};
  try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { /* pas de cache */ }
  const queue = rows.map((r) => r[cId]).filter((id) => id && !(id in cache));
  const total = queue.length;
  let done = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const id = queue.shift()!;
        try {
          const m = await graph<{ attachments?: { name?: string; isInline?: boolean }[] }>(
            `/me/messages/${encodeURIComponent(id)}?$select=id&$expand=attachments($select=name,isInline)`,
            { headers: { Prefer: PREFER } },
          );
          cache[id] = (m.attachments ?? [])
            .filter((a) => !a.isInline)
            .map((a) => a.name ?? '')
            .filter((n) => n && !/^image\d*\.(png|jpe?g|gif)$/i.test(n));
        } catch { /* réessayé au prochain lancement */ }
        process.stdout.write(`\r${++done}/${total}`);
      }
    }),
  );
  if (total) await fs.writeFile(cacheFile, JSON.stringify(cache));
  console.log('');

  // Prédiction finale SANS la règle de copie (configuration proposée)
  const all: R[] = [];
  for (const r of rows) {
    const original = byName.get(norm((r[cMine] ?? '').trim() || 'autre'));
    const c = agent.get(r[cId]);
    if (!original || !c) continue;
    const rec = recipients[r[cId]] ?? { to: [], cc: [] };
    const pred = c.model_category
      ? finalCategory(
        { ...c, category: c.model_category as Category },
        { from: r[cFrom] ?? '', to: rec.to, cc: rec.cc, me },
        { cc: false },
      ).category
      : toActive(c.category);
    all.push({ id: r[cId], truth: toActive(original), pred, subject: r[cSubj] ?? '', atts: cache[r[cId]] ?? [] });
  }

  const poRe = /(\bpo\b|bon.?de.?commande|commande|purchase.?order|\bbc\b)/i;
  const quoteRe = /(soumission|quote|rfq|devis|appel.?d.?offre|addend|\bbid\b|prix|price)/i;
  const pct = (x: number, n: number) => (n ? `${x} (${((100 * x) / n).toFixed(0)} %)` : '0');
  const group = (groupe: string, items: R[]) => ({
    groupe,
    n: items.length,
    'avec pièce jointe': pct(items.filter((i) => i.atts.length > 0).length, items.length),
    'nom type commande': pct(items.filter((i) => i.atts.some((a) => poRe.test(a))).length, items.length),
    'nom type soumission': pct(items.filter((i) => i.atts.some((a) => quoteRe.test(a))).length, items.length),
  });

  const misses = all.filter((i) => i.truth !== 'autre' && i.pred === 'autre');
  const hits = all.filter((i) => i.truth !== 'autre' && i.pred === i.truth);
  const autres = all.filter((i) => i.truth === 'autre');
  console.log('\nPièces jointes selon le résultat (configuration sans règle de copie) :');
  console.table([group('demandes MANQUÉES', misses), group('demandes CAPTÉES', hits), group('autre', autres)]);

  console.log('\nManqués ayant des pièces jointes (ton étiquette | objet | noms) :');
  for (const m of misses.filter((i) => i.atts.length).slice(0, 25)) {
    console.log(`${m.truth.padEnd(18)} | ${m.subject.slice(0, 45)} | ${m.atts.join(', ').slice(0, 80)}`);
  }

  // Les demandes que tu as confirmées au second passage sont-elles mieux captées ?
  try {
    const orig: Record<string, string> = JSON.parse(await fs.readFile(`eval/${tag}.recheck.orig.json`, 'utf8'));
    const [h2, ...r2] = parseCsv(await fs.readFile(`eval/${tag}.recheck.csv`, 'utf8'));
    const i2 = h2.indexOf('id');
    const m2 = h2.indexOf('ma_categorie');
    const byId = new Map(all.map((a) => [a.id, a]));
    const s = { stables: { n: 0, ok: 0 }, instables: { n: 0, ok: 0 } };
    // Le fichier recheck est vide (étiquettes à refaire) : on lit le nouveau passage dans le fichier que tu as rempli
    for (const r of r2) {
      const old = byName.get(norm(orig[r[i2]] ?? ''));
      const now = byName.get(norm((r[m2] ?? '').trim() || 'autre'));
      const a = byId.get(r[i2]);
      if (!old || !now || !a || toActive(old) === 'autre') continue;
      const key = toActive(old) === toActive(now) ? 'stables' : 'instables';
      s[key].n++;
      if (a.pred === a.truth) s[key].ok++;
    }
    console.log(`\nDemandes captées si ton étiquette est stable : ${pct(s.stables.ok, s.stables.n)} sur ${s.stables.n}`);
    console.log(`Demandes captées si ton étiquette a changé : ${pct(s.instables.ok, s.instables.n)} sur ${s.instables.n}`);
  } catch {
    console.log('\n(pas de fichier recheck : section stabilité ignorée)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});