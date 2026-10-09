import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { CATEGORIES, senderKind, toActive, type Category, type Classification } from './taxonomy.js';
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

async function loadAgent(tag: string, run: string) {
  const m = new Map<string, Classification | undefined>();
  for (const line of (await fs.readFile(`eval/${tag}.agent.${run}.jsonl`, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    m.set(r.id, r.classification);
  }
  return m;
}

async function main() {
  const tag = arg('tag', 'run2');
  const a = arg('a', '');
  const b = arg('b', '');
  if (!a || !b) throw new Error('Usage : --a runA --b runB [--tag run2]');

  const [head, ...rows] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const col = (n: string) => head.indexOf(n);
  const [cId, cFrom, cSubj, cMine] = ['id', 'de', 'objet', 'ma_categorie'].map(col);
  const A = await loadAgent(tag, a);
  const B = await loadAgent(tag, b);

  type Item = { kind: string; truth: Category; pa: Category; pb: Category; from: string; subject: string; action: string };
  const gains: Item[] = [];
  const regressions: Item[] = [];
  const neutral: Item[] = [];

  for (const r of rows) {
    const raw = (r[cMine] ?? '').trim() || 'autre';
    if (/^(ambigu|\?)$/i.test(raw)) continue;
    const original = byName.get(norm(raw));
    const ca = A.get(r[cId]);
    const cb = B.get(r[cId]);
    if (!original || !ca || !cb) continue;
    const truth = toActive(original);
    const pa = toActive(ca.category);
    const pb = toActive(cb.category);
    if (pa === pb) continue;
    const item: Item = {
      kind: senderKind(r[cFrom] ?? '') ?? 'externe',
      truth, pa, pb,
      from: r[cFrom] ?? '',
      subject: r[cSubj] ?? '',
      action: cb.last_message_action ?? cb.summary,
    };
    if (pa !== truth && pb === truth) gains.push(item);
    else if (pa === truth && pb !== truth) regressions.push(item);
    else neutral.push(item);
  }

  const byKind = (items: Item[]) => {
    const o: Record<string, number> = {};
    for (const i of items) o[i.kind] = (o[i.kind] ?? 0) + 1;
    return JSON.stringify(o);
  };
  console.log(`${a} → ${b}`);
  console.log(`Gains : ${gains.length} ${byKind(gains)}`);
  console.log(`Régressions : ${regressions.length} ${byKind(regressions)}`);
  console.log(`Changements sans effet (faux dans les deux cas) : ${neutral.length}`);

  console.log('\nRégressions (ton étiquette | avant → après | expéditeur | objet | ce que fait le message) :');
  for (const i of regressions) {
    console.log(`${i.truth.padEnd(10)} ${i.pa} → ${i.pb} | ${i.kind} | ${i.subject.slice(0, 55)} | ${i.action.slice(0, 70)}`);
  }
  console.log('\nGains :');
  for (const i of gains) {
    console.log(`${i.truth.padEnd(10)} ${i.pa} → ${i.pb} | ${i.kind} | ${i.subject.slice(0, 55)} | ${i.action.slice(0, 70)}`);
  }

  const all = [...regressions.map((i) => ['régression', i]), ...gains.map((i) => ['gain', i]), ...neutral.map((i) => ['neutre', i])] as [string, Item][];
  await fs.writeFile(
    `eval/${tag}.diff.${a}__${b}.csv`,
    toCsv([
      ['effet', 'type_expediteur', 'ma_categorie', 'avant', 'apres', 'de', 'objet', 'action'],
      ...all.map(([e, i]) => [e, i.kind, i.truth, i.pa, i.pb, i.from, i.subject, i.action]),
    ]),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});