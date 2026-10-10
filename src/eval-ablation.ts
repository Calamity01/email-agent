import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { CATEGORIES, toActive, type Category, type Classification } from './taxonomy.js';
import { finalCategory, type Opts } from './rules.js';
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

type Item = { truth: Category; c: Classification; from: string; to: string[]; cc: string[] };

async function main() {
  const tag = arg('tag', 'run3');
  const run = arg('run', 'final');
  const rules = arg('rules', 'v1') === 'v2' ? 'v2' : 'v1';
  const range = arg('rows', '').split('-').map(Number);
  const me = (process.env.EXPECTED_MAILBOX ?? '').toLowerCase();

  const [head, ...data] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const col = (n: string) => head.indexOf(n);
  const [cId, cFrom, cMine] = ['id', 'de', 'ma_categorie'].map(col);

  const agent = new Map<string, Classification>();
  for (const line of (await fs.readFile(`eval/${tag}.agent.${run}.jsonl`, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.classification) agent.set(r.id, r.classification);
  }
  const recipients: Record<string, { to: string[]; cc: string[] }> = JSON.parse(
    await fs.readFile(`eval/${tag}.recipients.json`, 'utf8'),
  );

  const useRange = range.length === 2 && range.every(Number.isFinite);
  const subset = useRange ? data.slice(range[0] - 1, range[1]) : data;
  const items: Item[] = [];
  for (const r of subset) {
    const raw = (r[cMine] ?? '').trim() || 'autre';
    if (/^(ambigu|\?)$/i.test(raw)) continue;
    const original = byName.get(norm(raw));
    const c = agent.get(r[cId]);
    if (!original || !c) continue;
    const rec = recipients[r[cId]] ?? { to: [], cc: [] };
    items.push({ truth: toActive(original), c, from: r[cFrom] ?? '', to: rec.to, cc: rec.cc });
  }
  console.log(`${tag} / ${run} : ${items.length} courriels${useRange ? ` (lignes ${range[0]}-${range[1]})` : ''}\n`);

  const predict = (it: Item, opts: Opts) => {
    if (!it.c.model_category) return { category: toActive(it.c.category), rule: 'raccourci local' };
    return finalCategory(
      { ...it.c, category: it.c.model_category as Category },
      { from: it.from, to: it.to, cc: it.cc, me },
      { rules, ...opts },
    );
  };

  const pct = (x: number) => `${(100 * x).toFixed(0)} %`;
  const stats = (opts: Opts) => {
    const preds = items.map((i) => predict(i, opts).category);
    let ok = 0, fp = 0, missed = 0;
    items.forEach((i, k) => {
      if (preds[k] === i.truth) ok++;
      if (i.truth === 'autre' && preds[k] !== 'autre') fp++;
      if (i.truth !== 'autre' && preds[k] === 'autre') missed++;
    });
    const pr = (c: Category) => {
      const predN = preds.filter((p) => p === c).length;
      const truthN = items.filter((i) => i.truth === c).length;
      const hit = items.filter((i, k) => i.truth === c && preds[k] === c).length;
      const P = predN ? hit / predN : 0;
      const R = truthN ? hit / truthN : 0;
      return { P, R, F: P + R ? (2 * P * R) / (P + R) : 0 };
    };
    const [s, n, u] = (['soumission', 'nouvelle_commande', 'suivi_commande'] as Category[]).map(pr);
    const fmt = (x: { P: number; R: number }) => `${pct(x.P)} / ${pct(x.R)}`;
    return {
      bonnes: ok,
      faux_positifs: fp,
      manques: missed,
      'soumission P/R': fmt(s),
      'commande P/R': fmt(n),
      'suivi P/R': fmt(u),
      focal: ((s.F + n.F + u.F) / 3).toFixed(2),
    };
  };

  const variants: [string, Opts][] = [
    ['modèle seul', { refine: false, po: false, cc: false }],
    ['+ filtres (informer, relance) seuls', { refine: true, po: false, cc: false }],
    ['+ bon de commande externe seul', { refine: false, po: true, cc: false }],
    ['+ copie (Cc) seule', { refine: false, po: false, cc: true }],
    ['FINAL (tout)', {}],
    ['final SANS filtres', { refine: false }],
    ['final SANS bon de commande externe', { po: false }],
    ['final SANS copie (Cc)', { cc: false }],
  ];
  const table: Record<string, ReturnType<typeof stats>> = {};
  for (const [name, opts] of variants) table[name] = stats(opts);
  console.table(table);

  const fields = (c: Classification) => [c.sender_role, c.act, c.topic, c.client_demand].join('/');
  const count = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const final = items.map((i) => ({ i, p: predict(i, { cc: false }) }));

  const misses = final.filter(({ i, p }) => i.truth !== 'autre' && p.category === 'autre');
  console.log(`\n== ${misses.length} demandes MANQUÉES : ton étiquette | cause`);
  for (const [k, n] of count(misses.map(({ i, p }) =>
    `${i.truth} | ${p.rule === 'modèle' ? `le modèle a dit autre : ${fields(i.c)}` : p.rule}`))) {
    console.log(`${String(n).padStart(4)}  ${k}`);
  }

  const fps = final.filter(({ i, p }) => i.truth === 'autre' && p.category !== 'autre');
  console.log(`\n== ${fps.length} FAUX POSITIFS : catégorie prédite | cause`);
  for (const [k, n] of count(fps.map(({ i, p }) => `${p.category} | ${p.rule} | ${fields(i.c)}`))) {
    console.log(`${String(n).padStart(4)}  ${k}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});