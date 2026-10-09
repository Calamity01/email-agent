import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { graph } from './graph.js';
import { PREFER, assertMailbox } from './mail.js';
import { CATEGORIES, senderKind, toActive, categoryIds, type Category } from './taxonomy.js';
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

type Addr = { emailAddress?: { address?: string } };
type Rec = { to: string[]; cc: string[] };

async function main() {
  const tag = arg('tag', 'run2');
  const me = await assertMailbox();
  const [head, ...rows] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const col = (n: string) => head.indexOf(n);
  const [cId, cFrom, cMine] = ['id', 'de', 'ma_categorie'].map(col);

  const cacheFile = `eval/${tag}.recipients.json`;
  let cache: Record<string, Rec> = {};
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  } catch { /* pas de cache */ }

  const missing = rows.map((r) => r[cId]).filter((id) => id && !cache[id]);
  let done = 0;
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const id = queue.shift()!;
        try {
          const m = await graph<{ toRecipients: Addr[]; ccRecipients: Addr[] }>(
            `/me/messages/${encodeURIComponent(id)}?$select=toRecipients,ccRecipients`,
            { headers: { Prefer: PREFER } },
          );
          const addrs = (l: Addr[]) => l.map((a) => (a.emailAddress?.address ?? '').toLowerCase());
          cache[id] = { to: addrs(m.toRecipients ?? []), cc: addrs(m.ccRecipients ?? []) };
        } catch {
          /* message introuvable : ignoré */
        }
        process.stdout.write(`\r${++done}/${missing.length}`);
      }
    }),
  );
  if (missing.length) await fs.writeFile(cacheFile, JSON.stringify(cache));
  console.log('');

  const position = (r: Rec) => {
    if (r.to.includes(me)) return r.to.length === 1 ? 'À (seul)' : 'À (+ autres)';
    if (r.cc.includes(me)) return 'Cc';
    return 'ni À ni Cc';
  };

  const groups: Record<string, Record<string, Record<string, number>>> = { interne: {}, externe: {} };
  for (const r of rows) {
    const raw = (r[cMine] ?? '').trim() || 'autre';
    if (/^(ambigu|\?)$/i.test(raw)) continue;
    const original = byName.get(norm(raw));
    const rec = cache[r[cId]];
    if (!original || !rec) continue;
    const kind = senderKind(r[cFrom] ?? '') === 'interne' ? 'interne' : 'externe';
    const pos = position(rec);
    const label = toActive(original);
    groups[kind][pos] ??= {};
    groups[kind][pos][label] = (groups[kind][pos][label] ?? 0) + 1;
  }

  for (const kind of ['interne', 'externe']) {
    console.log(`\nExpéditeur ${kind} : ta position dans les destinataires × ton étiquette`);
    const table: Record<string, Record<string, number>> = {};
    for (const [pos, labels] of Object.entries(groups[kind])) {
      table[pos] = {};
      for (const c of categoryIds) table[pos][c] = labels[c] ?? 0;
    }
    console.table(table);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});