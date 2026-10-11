import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { graph } from './graph.js';
import { PREFER, assertMailbox, toEmailInput, type InboxMessage } from './mail.js';
import { extractReferences, type Ref } from './refs.js';
import { parseCsv, toCsv } from './csv.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const TARGETS = new Set(['soumission', 'nouvelle_commande', 'suivi_commande']);
const fmt = (r: Ref) => `${r.kind}:${r.value}@${r.where}(${r.source})`;
const key = (s: string) => s.toUpperCase().replace(/[\s\u00A0]+/g, '').replace(/[–—\u2011]/g, '-');

function shuffle<T>(items: T[], seed: number): T[] {
  let a = seed;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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

async function score(file: string) {
  const [h, ...rows] = parseCsv(await fs.readFile(file, 'utf8'));
  const col = (n: string) => h.indexOf(n);
  const [cRefs, cRevu, cFaux, cManq] = ['references', 'revu', 'refs_fausses', 'refs_manquantes'].map(col);

  let reviewed = 0, cand = 0, bad = 0, perfect = 0, withMissing = 0, withRefs = 0;
  const bySource: Record<string, { n: number; bad: number }> = { regle: { n: 0, bad: 0 }, modele: { n: 0, bad: 0 } };
  const kinds: Record<string, number> = {};
  for (const r of rows) {
    if (!(r[cRevu] ?? '').trim()) continue;
    reviewed++;
    const items = (r[cRefs] ?? '').split(' ; ').map((s) => s.trim()).filter(Boolean);
    for (const it of items) kinds[it.split(':')[0]] = (kinds[it.split(':')[0]] ?? 0) + 1;
    const faux = (r[cFaux] ?? '').split(/[;,]/).map((s) => key(s)).filter(Boolean);
    const manquant = (r[cManq] ?? '').trim() !== '';
    if (items.length) withRefs++;
    let nBad = 0;
    for (const it of items) {
      const m = /^(\w+):(.*)@(\w+)\((regle|modele)\)$/.exec(it);
      if (!m) continue;
      cand++;
      const isBad = faux.includes(key(m[2]));
      bySource[m[4]].n++;
      if (isBad) { bad++; nBad++; bySource[m[4]].bad++; }
    }
    if (nBad === 0 && !manquant) perfect++;
    if (manquant) withMissing++;
  }
  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(0)} %` : '—');
  console.log(`Courriels revus : ${reviewed} (dont ${withRefs} avec au moins une référence extraite)`);
  console.log(`Références proposées : ${cand}, correctes : ${cand - bad} (${pct(cand - bad, cand)})`);
  for (const [s, v] of Object.entries(bySource)) console.log(`  source « ${s} » : ${v.n} proposées, ${pct(v.n - v.bad, v.n)} correctes`);
  console.log(`Courriels avec au moins un identifiant manquant : ${withMissing} (${pct(withMissing, reviewed)})`);
  console.log(`Courriels sans aucune erreur ni oubli : ${perfect} (${pct(perfect, reviewed)})`);
  console.log(`Références par courriel : ${(cand / reviewed).toFixed(1)} en moyenne`);
  console.log('Par type :', JSON.stringify(kinds));
}

async function main() {
  const tag = arg('tag', 'run4');
  const file = `eval/${tag}.refs.csv`;
  if (process.argv.includes('--score')) return score(file);

  if (await fs.access(file).then(() => true, () => false)) throw new Error(`${file} existe déjà : ne l'écrase pas.`);
  await assertMailbox();

  const [head, ...rows] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const col = (n: string) => head.indexOf(n);
  const [cId, cSubj, cLink, cMine] = ['id', 'objet', 'lien', 'ma_categorie'].map(col);
  const picked = shuffle(rows.filter((r) => TARGETS.has((r[cMine] ?? '').trim())), 3).slice(0, Number(arg('n', '60')));

  const messages: Record<string, InboxMessage> = JSON.parse(await fs.readFile(`eval/${tag}.messages.json`, 'utf8'));

  // Noms des pièces jointes (avec cache)
  const attFile = `eval/${tag}.attachments.json`;
  let att: Record<string, string[]> = {};
  try { att = JSON.parse(await fs.readFile(attFile, 'utf8')); } catch { /* pas de cache */ }
  await pool(picked.filter((r) => !(r[cId] in att)), 4, async (r) => {
    try {
      const m = await graph<{ attachments?: { name?: string; isInline?: boolean }[] }>(
        `/me/messages/${encodeURIComponent(r[cId])}?$select=id&$expand=attachments($select=name,isInline)`,
        { headers: { Prefer: PREFER } },
      );
      att[r[cId]] = (m.attachments ?? []).filter((a) => !a.isInline).map((a) => a.name ?? '').filter(Boolean);
    } catch { /* ignoré */ }
  });
  await fs.writeFile(attFile, JSON.stringify(att));

  let done = 0;
  const results = await pool(picked, 4, async (r) => {
    const m = messages[r[cId]];
    if (!m) return [] as Ref[];
    const input = toEmailInput(m);
    input.attachmentNames = (att[r[cId]] ?? []).filter((n) => !/^image\d*\.(png|jpe?g|gif)$/i.test(n));
    const refs = await extractReferences(input);
    process.stdout.write(`\r${++done}/${picked.length}`);
    return refs;
  });
  process.stdout.write('\n');

  await fs.writeFile(
    file,
    toCsv([
      ['id', 'objet', 'categorie', 'lien', 'references', 'revu', 'refs_fausses', 'refs_manquantes'],
      ...picked.map((r, i) => [
        r[cId], r[cSubj] ?? '', (r[cMine] ?? '').trim(), r[cLink] ?? '',
        results[i].map(fmt).join(' ; '), '', '', '',
      ]),
    ]),
  );
  console.log(`Feuille de revue : ${file}`);
  console.log('Pour chaque ligne : mets « o » dans « revu » ; écris dans « refs_fausses » les valeurs qui ne sont PAS un identifiant utile ;');
  console.log('(un numéro de pièce, d\'article ou de directive du client compte comme acceptable) ;'); 
  console.log('écris dans « refs_manquantes » les identifiants utiles que l\'extraction a ratés. Puis : npm run eval:refs -- --tag ' + tag + ' --score');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});