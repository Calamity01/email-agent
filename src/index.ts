import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { classifyEmail } from './classify.js';
import { assertMailbox, fetchSince, toEmailInput } from './mail.js';

const DATA_DIR = 'data';
const STATE_FILE = `${DATA_DIR}/state.json`;
const LOG_FILE = `${DATA_DIR}/classifications.jsonl`;

const POLL_MS = 3 * 60 * 1000; // vérifie aux 3 minutes
const MAX_PER_RUN = 50;        // garde-fou de coût par cycle
const LOOKBACK_DAYS = 3;       // au tout premier lancement

type State = { lastReceived: string; processed: string[] };

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
    return { lastReceived: since, processed: [] };
  }
}

async function saveState(s: State) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(s));
}

async function runOnce() {
  const state = await loadState();
  const seen = new Set(state.processed);

  // Le filtre est inclusif : on en demande un peu plus pour écarter ceux déjà traités
  const fetched = await fetchSince(state.lastReceived, MAX_PER_RUN + 20);
  const fresh = fetched.filter((m) => !seen.has(m.id)).slice(0, MAX_PER_RUN);
  if (fresh.length === 0) return;

  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const m of fresh) {
    const input = toEmailInput(m);
    const entry: Record<string, unknown> = {
      at: new Date().toISOString(),
      id: m.id,
      receivedDateTime: m.receivedDateTime,
      from: input.from,
      subject: input.subject,
    };

    try {
      const c = await classifyEmail(input);
      entry.classification = c;
      console.log(`[${c.category}] [${c.urgency}] ${input.subject}`);
    } catch (e) {
      // L'échec est journalisé (champ « error ») et le courriel n'est pas rejoué
      entry.error = e instanceof Error ? e.message : String(e);
      console.error(`Échec : ${input.subject} — ${entry.error}`);
    }

    await fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n');
    seen.add(m.id);
    state.lastReceived = m.receivedDateTime;
    state.processed = [...seen].slice(-500);
    await saveState(state);
  }
}

async function main() {
  await assertMailbox();
  const once = process.argv.includes('--once');
  do {
    try {
      await runOnce();
    } catch (e) {
      console.error('Erreur du cycle :', e);
    }
    if (!once) await new Promise((r) => setTimeout(r, POLL_MS));
  } while (!once);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});