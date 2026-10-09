import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { senderKind } from './taxonomy.js';
import { parseCsv } from './csv.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const prefix = (s: string) =>
  /^\s*(tr|fw|fwd)\s*:/i.test(s) ? 'TR/FW' : /^\s*re\s*:/i.test(s) ? 'RE' : 'aucun';

type Item = { from: string; subject: string; truth: string; original: string; pred: string };

function tally(items: Item[], key: (i: Item) => string) {
  const out: Record<string, Record<string, number>> = {};
  for (const i of items) {
    const k = key(i);
    out[k] ??= {};
    out[k][i.pred] = (out[k][i.pred] ?? 0) + 1;
  }
  return out;
}

async function main() {
  const tag = arg('tag', 'run1');
  const run = arg('run', '');
  const suffix = run ? `.${run}` : '';
  const [head, ...rows] = parseCsv(await fs.readFile(`eval/${tag}.disagreements${suffix}.csv`, 'utf8'));
  const col = (n: string) => head.indexOf(n);

  const items: Item[] = rows.map((r) => ({
    from: (r[col('de')] ?? '').toLowerCase(),
    subject: r[col('objet')] ?? '',
    truth: r[col('ma_categorie')] ?? '',
    original: r[col('mon_etiquette_originale')] ?? '',
    pred: r[col('agent')] ?? '',
  }));

  const fp = items.filter((i) => i.truth === 'autre'); // « autre » classé comme demande visée
  const missed = items.filter((i) => i.truth !== 'autre'); // demande visée manquée ou mauvais type

  console.log(`${fp.length} faux positifs\n`);
  console.log('Selon ton étiquette d\'origine (lignes) et la prédiction de l\'agent (colonnes) :');
  console.table(tally(fp, (i) => i.original));

  const kind = (i: Item) => senderKind(i.from) ?? 'externe';
  console.log('Selon le type d\'expéditeur (d\'après .env) :');
  console.table(tally(fp, kind));

  console.log('Selon le préfixe de l\'objet :');
  console.table(tally(fp, (i) => prefix(i.subject)));

  const bySender = new Map<string, number>();
  for (const i of fp) bySender.set(i.from, (bySender.get(i.from) ?? 0) + 1);
  console.log('Expéditeurs les plus fréquents parmi les faux positifs :');
  for (const [from, n] of [...bySender].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`${String(n).padStart(4)}  ${from}`);
  }

  console.log('\nTous les faux positifs (étiquette d\'origine → agent | expéditeur | objet) :');
  for (const i of fp) {
    console.log(`${i.original.padEnd(12)} → ${i.pred.padEnd(18)} | ${i.from.padEnd(34)} | ${i.subject.slice(0, 60)}`);
  }

  console.log('\nDemandes visées manquées ou mal typées (ton étiquette → agent) :');
  for (const i of missed) {
    console.log(`${i.original.padEnd(18)} → ${i.pred.padEnd(18)} | ${i.from.padEnd(34)} | ${i.subject.slice(0, 60)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});