import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { graph } from './graph.js';
import { classifyEmail } from './classify.js';
import { PREFER, assertMailbox, toEmailInput, type InboxMessage } from './mail.js';
import { parseCsv } from './csv.js';
import type { Classification } from './taxonomy.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
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

type Out = { id: string; classification?: Classification; error?: string };

async function main() {
  const tag = arg('tag', 'run1');
  const run = arg('run', '');
  if (!run) throw new Error('Indique un nom de version : --run v2');

  const outFile = `eval/${tag}.agent.${run}.jsonl`;
  const exists = await fs.access(outFile).then(() => true, () => false);
  if (exists) throw new Error(`${outFile} existe déjà. Choisis un autre nom avec --run.`);

  const [head, ...rows] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
  const idCol = head.indexOf('id');
  const ids = rows.map((r) => r[idCol]).filter(Boolean);

  const cacheFile = `eval/${tag}.messages.json`;
  let cache: Record<string, InboxMessage> = {};
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  } catch { /* pas de cache */ }

  const missing = ids.filter((id) => !cache[id]);
  if (missing.length) {
    await assertMailbox();
    console.log(`Téléchargement de ${missing.length} courriels…`);
    await pool(missing, 4, async (id) => {
      try {
        cache[id] = await graph<InboxMessage>(
          `/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,receivedDateTime,conversationId,body`,
          { headers: { Prefer: PREFER } },
        );
      } catch {
        console.error(`\nIntrouvable : ${id}`);
      }
    });
    await fs.writeFile(cacheFile, JSON.stringify(cache));
  }

  let done = 0;
  const results = await pool(ids, 4, async (id): Promise<Out> => {
    const msg = cache[id];
    let out: Out;
    if (!msg) out = { id, error: 'message introuvable' };
    else {
      try {
        out = { id, classification: await classifyEmail(toEmailInput(msg)) };
      } catch (e) {
        out = { id, error: e instanceof Error ? e.message : String(e) };
      }
    }
    process.stdout.write(`\r${++done}/${ids.length}`);
    return out;
  });
  process.stdout.write('\n');

  await fs.writeFile(outFile, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`Écrit : ${outFile}`);
  console.log(`Compare : npm run eval:compare -- --tag ${tag} --run ${run}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});