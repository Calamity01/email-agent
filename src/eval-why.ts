import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { CATEGORIES, toActive, type Category } from './taxonomy.js';
import { explainCategory } from './fields.js';
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

type Row = {
  truth: Category;
  pred: Category;
  modelCat: Category;
  rule: string;
  fields: string;
  subject: string;
  action: string;
};

function count(items: Row[], key: (r: Row) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const r of items) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const tag = arg('tag', 'run2');
  const run = arg('run', '');
  if (!run) throw new Error('Usage : --run v5-champs [--tag run2]');

  const [head, ...rows] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const col = (n: string) => head.indexOf(n);
  const [cId, cSubj, cMine] = ['id', 'objet', 'ma_categorie'].map(col);

  const agent = new Map<string, any>();
  for (const line of (await fs.readFile(`eval/${tag}.agent.${run}.jsonl`, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    agent.set(r.id, r.classification);
  }

  const all: Row[] = [];
  for (const r of rows) {
    const raw = (r[cMine] ?? '').trim() || 'autre';
    if (/^(ambigu|\?)$/i.test(raw)) continue;
    const original = byName.get(norm(raw));
    const c = agent.get(r[cId]);
    if (!original || !c) continue;
    const { category, rule } = c.sender_role
      ? explainCategory(c)
      : { category: toActive(c.category as Category), rule: 'raccourci local (Zoho)' };
    all.push({
      truth: toActive(original),
      pred: category,
      modelCat: toActive((c.model_category ?? c.category) as Category),
      rule,
      fields: [c.sender_role, c.act, c.topic, c.client_demand].join(' / '),
      subject: r[cSubj] ?? '',
      action: c.last_message_action ?? '',
    });
  }

  const misses = all.filter((r) => r.truth !== 'autre' && r.pred === 'autre');
  const fps = all.filter((r) => r.truth === 'autre' && r.pred !== 'autre');

  console.log(`\n== ${misses.length} demandes MANQUÉES : ton étiquette | règle qui les a envoyées en « autre »`);
  for (const [k, n] of count(misses, (r) => `${r.truth} | ${r.rule}`)) console.log(`${String(n).padStart(4)}  ${k}`);

  console.log(`\n== ${fps.length} FAUX POSITIFS : catégorie prédite | champs (rôle / acte / sujet / client_demand)`);
  for (const [k, n] of count(fps, (r) => `${r.pred} | ${r.fields}`)) console.log(`${String(n).padStart(4)}  ${k}`);

  const overrides = all.filter((r) => r.modelCat !== r.pred);
  const tableRight = overrides.filter((r) => r.pred === r.truth).length;
  const modelRight = overrides.filter((r) => r.modelCat === r.truth).length;
  console.log(
    `\n== La table a corrigé le modèle ${overrides.length} fois : ` +
    `table juste ${tableRight}, modèle juste ${modelRight}, aucun des deux ${overrides.length - tableRight - modelRight}`,
  );
  for (const [k, n] of count(overrides, (r) => `${r.modelCat} → ${r.pred} (règle ${r.rule}) | tu avais : ${r.truth}`)) {
    console.log(`${String(n).padStart(4)}  ${k}`);
  }

  console.log('\n== Détail des manqués (ton étiquette | champs | objet | ce que fait le message)');
  for (const r of misses) {
    console.log(`${r.truth.padEnd(18)} | ${r.fields} | ${r.subject.slice(0, 50)} | ${r.action.slice(0, 70)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});