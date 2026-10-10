import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { CATEGORIES, toActive, type Category, type Classification } from './taxonomy.js';
import { finalCategory } from './rules.js';
import { parseCsv } from './csv.js';

const SETS = [
  { tag: 'run2', run: 'v7-final' },
  { tag: 'run3', run: 'final' },
  { tag: 'run4', run: 'v1' },
];
// Fixés AVANT de voir les résultats
const MIN_N = 5;
const MIN_SHARE = 0.8;

const norm = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
const byName = new Map<string, Category>();
for (const [id, c] of Object.entries(CATEGORIES)) {
  byName.set(norm(id), id as Category);
  byName.set(norm(c.label), id as Category);
}

type Item = { from: string; truth: Category; base: Category };
type Pair = { truth: Category; pred: Category };
type Counts = Record<string, number>;

async function loadSet(tag: string, run: string, me: string): Promise<Item[]> {
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

  const out: Item[] = [];
  for (const r of rows) {
    const raw = (r[cMine] ?? '').trim() || 'autre';
    if (/^(ambigu|\?)$/i.test(raw)) continue;
    const original = byName.get(norm(raw));
    const c = agent.get(r[cId]);
    if (!original || !c) continue;
    const rec = recipients[r[cId]] ?? { to: [], cc: [] };
    const base = c.model_category
      ? finalCategory(
        { ...c, category: c.model_category as Category },
        { from: r[cFrom] ?? '', subject: r[cSubj] ?? '', to: rec.to, cc: rec.cc, me },
        { rules: 'v1', cc: true },
      ).category
      : toActive(c.category);
    out.push({ from: (r[cFrom] ?? '').toLowerCase(), truth: toActive(original), base });
  }
  return out;
}

function buildPriors(items: Item[]): Map<string, Counts> {
  const m = new Map<string, Counts>();
  for (const it of items) {
    const c = m.get(it.from) ?? {};
    c[it.truth] = (c[it.truth] ?? 0) + 1;
    m.set(it.from, c);
  }
  return m;
}

function prior(p: Map<string, Counts>, from: string): Category | null {
  const c = p.get(from);
  if (!c) return null;
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  if (total < MIN_N) return null;
  const [best, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return n / total >= MIN_SHARE ? (best as Category) : null;
}

function metrics(pairs: Pair[]) {
  const ok = pairs.filter((p) => p.truth === p.pred).length;
  const fp = pairs.filter((p) => p.truth === 'autre' && p.pred !== 'autre').length;
  const missed = pairs.filter((p) => p.truth !== 'autre' && p.pred === 'autre').length;
  const targets: Category[] = ['soumission', 'nouvelle_commande', 'suivi_commande'];
  const f1 = targets.map((c) => {
    const predN = pairs.filter((p) => p.pred === c).length;
    const truthN = pairs.filter((p) => p.truth === c).length;
    const hit = pairs.filter((p) => p.truth === c && p.pred === c).length;
    const P = predN ? hit / predN : 0;
    const R = truthN ? hit / truthN : 0;
    return P + R ? (2 * P * R) / (P + R) : 0;
  });
  return {
    n: pairs.length,
    bonnes: ok,
    faux_positifs: fp,
    manques: missed,
    focal: (f1.reduce((a, b) => a + b, 0) / 3).toFixed(2),
  };
}

async function main() {
  const me = (process.env.EXPECTED_MAILBOX ?? '').toLowerCase();
  const sets: { tag: string; items: Item[] }[] = [];
  for (const s of SETS) sets.push({ tag: s.tag, items: await loadSet(s.tag, s.run, me) });

  const rows: Record<string, unknown>[] = [];
  const allBase: Pair[] = [];
  const allComb: Pair[] = [];
  let tFired = 0, tFiredPrior = 0, tFiredModel = 0;

  for (const test of sets) {
    const train = sets.filter((s) => s.tag !== test.tag).flatMap((s) => s.items);
    const priors = buildPriors(train);
    const base: Pair[] = [];
    const comb: Pair[] = [];
    let fired = 0, firedPrior = 0, firedModel = 0;

    for (const it of test.items) {
      base.push({ truth: it.truth, pred: it.base });
      const pr = prior(priors, it.from);
      if (pr) {
        fired++;
        if (pr === it.truth) firedPrior++;
        if (it.base === it.truth) firedModel++;
      }
      comb.push({ truth: it.truth, pred: pr ?? it.base });
    }
    allBase.push(...base);
    allComb.push(...comb);
    tFired += fired; tFiredPrior += firedPrior; tFiredModel += firedModel;

    rows.push({ jeu: test.tag, methode: 'modèle + Cc', ...metrics(base) });
    rows.push({
      jeu: test.tag,
      methode: '+ historique expéditeur',
      ...metrics(comb),
      'règle active': `${fired}/${test.items.length}`,
      'règle juste': firedPrior,
      'modèle juste (mêmes courriels)': firedModel,
    });
  }
  rows.push({ jeu: 'TOTAL', methode: 'modèle + Cc', ...metrics(allBase) });
  rows.push({
    jeu: 'TOTAL',
    methode: '+ historique expéditeur',
    ...metrics(allComb),
    'règle active': `${tFired}/${allBase.length}`,
    'règle juste': tFiredPrior,
    'modèle juste (mêmes courriels)': tFiredModel,
  });
  console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});