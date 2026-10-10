import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { CATEGORIES, categoryIds, toActive, type Category } from './taxonomy.js';
import { parseCsv, toCsv } from './csv.js';

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

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  const tag = arg('tag', 'run3');
  const n = Number(arg('n', '100'));
  const outFile = `eval/${tag}.recheck.csv`;
  const origFile = `eval/${tag}.recheck.orig.json`;

  const [head, ...rows] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const col = (c: string) => head.indexOf(c);
  const [cId, cMine] = ['id', 'ma_categorie'].map(col);

  if (!process.argv.includes('--score')) {
    // Création : moitié de courriels étiquetés comme demandes, moitié laissés vides
    const exists = await fs.access(outFile).then(() => true, () => false);
    if (exists) throw new Error(`${outFile} existe déjà : ne l'écrase pas.`);
    const targets = shuffle(rows.filter((r) => (r[cMine] ?? '').trim() !== ''), 5).slice(0, n / 2);
    const others = shuffle(rows.filter((r) => (r[cMine] ?? '').trim() === ''), 6).slice(0, n / 2);
    const picked = shuffle([...targets, ...others], 7);

    const orig: Record<string, string> = {};
    for (const r of picked) orig[r[cId]] = (r[cMine] ?? '').trim() || 'autre';
    await fs.writeFile(origFile, JSON.stringify(orig));
    await fs.writeFile(
      outFile,
      toCsv([head, ...picked.map((r) => r.map((v, i) => (i === cMine ? '' : v)))]),
    );
    console.log(`${picked.length} courriels à ré-étiqueter dans ${outFile} (case vide = autre).`);
    console.log(`Quand c'est fini : npm run eval:recheck -- --tag ${tag} --score`);
    return;
  }

  // Score : ancien vs nouveau
  const orig: Record<string, string> = JSON.parse(await fs.readFile(origFile, 'utf8'));
  const [h2, ...r2] = parseCsv(await fs.readFile(outFile, 'utf8'));
  const [i2, subj2, mine2] = ['id', 'objet', 'ma_categorie'].map((c) => h2.indexOf(c));

  const matrix: Record<string, Record<string, number>> = {};
  for (const a of categoryIds) {
    matrix[a] = {};
    for (const b of categoryIds) matrix[a][b] = 0;
  }
  const diffs: string[] = [];
  let same = 0, total = 0, targetsSame = 0, targetsTotal = 0, othersSame = 0, othersTotal = 0;

  for (const r of r2) {
    const oldRaw = orig[r[i2]];
    const oldC = oldRaw ? byName.get(norm(oldRaw)) : undefined;
    const newC = byName.get(norm((r[mine2] ?? '').trim() || 'autre'));
    if (!oldC || !newC) continue;
    const a = toActive(oldC);
    const b = toActive(newC);
    matrix[a][b]++;
    total++;
    if (a === b) same++;
    if (a !== 'autre') { targetsTotal++; if (a === b) targetsSame++; }
    else { othersTotal++; if (a === b) othersSame++; }
    if (a !== b) diffs.push(`${a} → ${b} | ${(r[subj2] ?? '').slice(0, 70)}`);
  }

  const pct = (x: number, y: number) => (y ? `${((100 * x) / y).toFixed(0)} %` : '—');
  console.log(`Accord avec toi-même : ${same}/${total} (${pct(same, total)})`);
  console.log(`  parmi tes demandes d'origine : ${targetsSame}/${targetsTotal} (${pct(targetsSame, targetsTotal)})`);
  console.log(`  parmi tes « autre » d'origine : ${othersSame}/${othersTotal} (${pct(othersSame, othersTotal)})`);
  console.log('\nAncienne étiquette (lignes) × nouvelle (colonnes) :');
  console.table(matrix);
  console.log('\nChangements :');
  for (const d of diffs) console.log(`  ${d}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});