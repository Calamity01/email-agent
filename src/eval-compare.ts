import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { CATEGORIES, categoryIds, toActive, type Category, type Classification, senderKind } from './taxonomy.js';
import { parseCsv, toCsv } from './csv.js';
import { refineCategory } from './fields.js';
import { finalCategory } from './rules.js';

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

type Pair = {
  truth: Category;     // ton étiquette, regroupée sur les catégories actives
  original: Category;  // ton étiquette d'origine
  pred: Category;      // prédiction de l'agent, regroupée
  row: string[];
  confidence: string;
  summary: string;
  action: string;
  fields: string;
};

async function main() {
  const tag = arg('tag', 'run1');
  const run = arg('run', '');
  const suffix = run ? `.${run}` : '';
  const blankIsAutre = process.argv.includes('--blank-autre');

  const [head, ...data] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const col = (n: string) => head.indexOf(n);
  const [cId, cDate, cFrom, cSubj, cLink, cMine] =
    ['id', 'date', 'de', 'objet', 'lien', 'ma_categorie'].map(col);
  if (cId < 0 || cMine < 0) throw new Error('Colonnes id / ma_categorie introuvables');

  const agent = new Map<string, { classification?: Classification; error?: string }>();
  for (const line of (await fs.readFile(`eval/${tag}.agent${suffix}.jsonl`, 'utf8')).split('\n')) {
    if (line.trim()) {
      const r = JSON.parse(line);
      agent.set(r.id, r);
    }
  }

  const pairs: Pair[] = [];
  const unknownLabels = new Set<string>();
  let unlabeled = 0;
  let agentErrors = 0;
  let ambiguous = 0;
  const useFinal = process.argv.includes('--final');
  const me = (process.env.EXPECTED_MAILBOX ?? '').toLowerCase();
  const recipients: Record<string, { to: string[]; cc: string[] }> = useFinal
    ? JSON.parse(await fs.readFile(`eval/${tag}.recipients.json`, 'utf8'))
    : {};
  for (const row of data) {
    let raw = (row[cMine] ?? '').trim();
    if (/^(ambigu|\?)$/i.test(raw)) { ambiguous++; continue; }
    if (!raw) {
      if (!blankIsAutre) { unlabeled++; continue; }
      raw = 'autre';
    }
    const original = byName.get(norm(raw));
    if (!original) { unknownLabels.add(raw); continue; }
    const a = agent.get(row[cId]);
    if (!a?.classification) { agentErrors++; continue; }
    const c = a.classification;
    const useModel = process.argv.includes('--model-category');
    const useHybrid = process.argv.includes('--hybrid');
    let predicted = (useModel && c.model_category ? c.model_category : c.category) as Category;
    if (useHybrid && c.model_category) {
      predicted = refineCategory({ ...c, category: c.model_category as Category }).category;
    }
    if (useFinal && c.model_category) {
      const rec = recipients[row[cId]] ?? { to: [], cc: [] };
      predicted = finalCategory(
        { ...c, category: c.model_category as Category },
        { from: row[cFrom] ?? '', to: rec.to, cc: rec.cc, me },
      ).category;
    }
    pairs.push({
      truth: toActive(original),
      original,
      pred: toActive(predicted),
      row,
      confidence: c.confidence,
      summary: c.summary,
      action: c.last_message_action ?? '',
      fields: [c.sender_role, c.act, c.topic, c.client_demand].join(' / '),
    });
  }

  console.log(`Catégories actives : ${categoryIds.join(', ')}`);
  console.log(`Lignes valides : ${pairs.length} | sans étiquette : ${unlabeled} | échecs de l'agent : ${agentErrors} | ambigus (exclus) : ${ambiguous}`);
  if (unknownLabels.size) console.log(`Étiquettes non reconnues (ignorées) : ${[...unknownLabels].join(', ')}`);
  if (pairs.length === 0) return;

  const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
  const n = pairs.length;
  const ok = pairs.filter((p) => p.truth === p.pred).length;
  const allAutre = pairs.filter((p) => p.truth === 'autre').length;
  console.log(
    `\nConcordance globale : ${ok}/${n} (${pct(ok / n)}). ` +
    `Référence « toujours autre » : ${pct(allAutre / n)}. Ce chiffre global compte peu : regarde les catégories visées.`,
  );

  const stat = (c: Category) => {
    const truthN = pairs.filter((p) => p.truth === c).length;
    const predN = pairs.filter((p) => p.pred === c).length;
    const hit = pairs.filter((p) => p.truth === c && p.pred === c).length;
    const precision = predN ? hit / predN : 0;
    const recall = truthN ? hit / truthN : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { truthN, predN, precision, recall, f1 };
  };

  console.log('\nPar catégorie (rappel = parmi tes étiquettes ; précision = parmi les prédictions de l\'agent) :');
  console.table(
    categoryIds.map((c) => {
      const s = stat(c);
      return {
        categorie: c,
        tes_etiquettes: s.truthN,
        predites: s.predN,
        rappel: pct(s.recall),
        precision: pct(s.precision),
        f1: s.f1.toFixed(2),
      };
    }),
  );

  const focus = categoryIds.filter((c) => c !== 'autre');
  const focal = focus.reduce((sum, c) => sum + stat(c).f1, 0) / focus.length;
  console.log(`Score focal (F1 moyen sur ${focus.join(', ')}) : ${focal.toFixed(2)}`);
  const small = focus.filter((c) => stat(c).truthN < 15);
  if (small.length) {
    console.log(`Attention : moins de 15 exemples pour ${small.join(', ')}. Ces chiffres varient beaucoup d'un échantillon à l'autre.`);
  }

  const falsePos = pairs.filter((p) => p.truth === 'autre' && p.pred !== 'autre').length;
  const missed = pairs.filter((p) => p.truth !== 'autre' && p.pred === 'autre').length;
  const wrongType = pairs.filter((p) => p.truth !== 'autre' && p.pred !== 'autre' && p.truth !== p.pred).length;
  console.log(
    `\nFaux positifs (« autre » classé comme demande visée) : ${falsePos}` +
    `\nManqués (demande visée classée « autre ») : ${missed}` +
    `\nMauvais type parmi les demandes visées : ${wrongType}`,
  );

  console.log('\nMatrice de confusion (lignes = ton étiquette, colonnes = agent) :');
  const matrix: Record<string, Record<string, number>> = {};
  for (const t of categoryIds) {
    matrix[t] = {};
    for (const p of categoryIds) matrix[t][p] = pairs.filter((x) => x.truth === t && x.pred === p).length;
  }
  console.table(matrix);

  const diffs = pairs.filter((p) => p.truth !== p.pred);
  await fs.writeFile(
    `eval/${tag}.disagreements${suffix}.csv`,
    toCsv([
      ['date', 'de', 'objet', 'ma_categorie', 'mon_etiquette_originale', 'agent', 'confiance', 'resume_agent', 'action_dernier_message', 'lien', 'champs'],
      ...diffs.map((p) => [
        p.row[cDate] ?? '', p.row[cFrom] ?? '', p.row[cSubj] ?? '',
        p.truth, p.original, p.pred, p.confidence, p.summary, p.action, p.row[cLink] ?? '', p.fields,
      ]),
    ]),
  );
  console.log(`\n${diffs.length} désaccords écrits dans eval/${tag}.disagreements${suffix}.csv`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});