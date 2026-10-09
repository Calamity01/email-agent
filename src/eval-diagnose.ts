import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { CATEGORIES, categoryIds, senderKind, type Category } from './taxonomy.js';
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

type Item = { label: Category; from: string; subject: string; kind: string };

async function main() {
  const tag = arg('tag', 'run1');
  const [head, ...rows] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const col = (n: string) => head.indexOf(n);

  const items: Item[] = [];
  for (const r of rows) {
    const label = byName.get(norm(r[col('ma_categorie')] ?? ''));
    if (!label) continue;
    const from = (r[col('de')] ?? '').toLowerCase();
    items.push({
      label,
      from,
      subject: r[col('objet')] ?? '',
      kind: senderKind(from) ?? 'externe',
    });
  }

  console.log('Type d\'expéditeur (selon .env) × ton étiquette :');
  const cross: Record<string, Record<string, number>> = {};
  for (const k of ['interne', 'fournisseur', 'externe']) {
    cross[k] = {};
    for (const c of Object.keys(CATEGORIES) as Category[]) cross[k][c] = items.filter((i) => i.kind === k && i.label === c).length;
  }
  console.table(cross);

  const internal = items.filter((i) => i.kind === 'interne');
  const byAddr = new Map<string, Item[]>();
  for (const i of internal) byAddr.set(i.from, [...(byAddr.get(i.from) ?? []), i]);

  console.log('\nExpéditeurs internes les plus fréquents (adresse, nombre, tes étiquettes) :');
  const top = [...byAddr.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 15);
  for (const [addr, list] of top) {
    const counts = new Map<string, number>();
    for (const i of list) counts.set(i.label, (counts.get(i.label) ?? 0) + 1);
    const summary = [...counts].map(([k, v]) => `${k}:${v}`).join('  ');
    console.log(`${String(list.length).padStart(3)}  ${addr.padEnd(42)} ${summary}`);
  }

  const odd = internal.filter((i) => i.label !== 'interne');
  const isFwd = (s: string) => /^\s*(tr|fw|fwd)\s*:/i.test(s);
  const isRe = (s: string) => /^\s*re\s*:/i.test(s);
  console.log(
    `\n${odd.length} courriels de domaines internes étiquetés autrement que « interne » : ` +
    `${odd.filter((i) => isFwd(i.subject)).length} transferts (TR:/FW:), ` +
    `${odd.filter((i) => isRe(i.subject)).length} réponses (RE:), ` +
    `${odd.filter((i) => !isFwd(i.subject) && !isRe(i.subject)).length} autres.`,
  );
  console.log('\nÉtiquette           Expéditeur                           Objet');
  for (const i of odd.slice(0, 45)) {
    console.log(`${i.label.padEnd(19)} ${i.from.padEnd(36)} ${i.subject.slice(0, 70)}`);
  }
  const prefix = (s: string) => (isFwd(s) ? 'TR/FW' : isRe(s) ? 'RE' : 'aucun');
  console.log("\nExpéditeurs internes : préfixe de l'objet × « interne » :");
  for (const p of ['RE', 'TR/FW', 'aucun']) {
    const sub = internal.filter((i) => prefix(i.subject) === p);
    console.log(`  ${p.padEnd(6)} ${String(sub.length).padStart(3)} courriels, dont ${sub.filter((i) => i.label === 'interne').length} étiquetés « interne »`);
  }

  console.log('\nExpéditeurs externes étiquetés fournisseur / info / autre :');
  const ext = items.filter((x) => x.kind === 'externe' && ['fournisseur', 'info', 'autre'].includes(x.label));
  for (const i of ext.slice(0, 30)) {
    console.log(`${i.label.padEnd(12)} ${i.from.padEnd(36)} ${i.subject.slice(0, 70)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});