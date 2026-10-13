import { promises as fs } from 'node:fs';
import type { InboxMessage } from './mail.js';
import type { Classification, EmailInput } from './taxonomy.js';
import type { Ref } from './refs.js';
import type { EmailTriage } from './triage-types.js';

const OUTBOX = 'data/outbox.jsonl';
const REJECTED = 'data/outbox.rejected.jsonl';

class ApiError extends Error {
  constructor(public status: number) { super(`API ${status}`); }
}
// Le backend refuse la fiche elle-même : inutile de la renvoyer indéfiniment.
// (401/403/5xx/réseau restent « temporaires » : on garde la fiche pour plus tard.)
const permanent = (e: unknown) => e instanceof ApiError && [400, 413, 422].includes(e.status);

export function buildTriage(
  m: InboxMessage,
  input: EmailInput,
  c: Classification,
  refs: Ref[] = [],
  rule?: string,
): EmailTriage {
  return {
    messageId: m.id,
    receivedAt: m.receivedDateTime,
    from: input.from,
    subject: input.subject,
    webLink: m.webLink ?? null,
    category: c.category,
    modelCategory: c.model_category ?? null,
    rule: rule ?? null,
    urgency: c.urgency,
    requiresReply: c.requires_reply,
    confidence: c.confidence,
    language: c.language,
    summary: c.summary,
    refs: refs.map(({ kind, value, where, source }) => ({ kind, value, where, source })),
  };
}

async function post(payload: EmailTriage) {
  const res = await fetch(process.env.TRIAGE_API_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.TRIAGE_API_KEY ?? '' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ApiError(res.status);
}

/** Ne lève jamais d'exception : en cas d'échec, la fiche attend dans data/outbox.jsonl. */
export async function pushTriage(payload: EmailTriage): Promise<void> {
  if (!process.env.TRIAGE_API_URL) return; // désactivé tant que l'URL n'est pas configurée
  try {
    await post(payload);
  } catch (e) {
    const file = permanent(e) ? REJECTED : OUTBOX;
    await fs.mkdir('data', { recursive: true });
    await fs.appendFile(file, JSON.stringify(payload) + '\n').catch(() => { });
    console.error(`   envoi au backend différé (${e instanceof Error ? e.message : e}) : ${payload.subject}`);
  }
}

/** Rejoue la file d'attente. À appeler au début de chaque cycle. */
export async function flushOutbox(): Promise<void> {
  if (!process.env.TRIAGE_API_URL) return;
  let lines: string[];
  try {
    lines = (await fs.readFile(OUTBOX, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return; // pas de file d'attente
  }
  const left: string[] = [];
  for (const line of lines) {
    try {
      await post(JSON.parse(line));
    } catch (e) {
      if (permanent(e)) await fs.appendFile(REJECTED, line + '\n').catch(() => { });
      else left.push(line);
    }
  }
  await fs.writeFile(OUTBOX, left.length ? left.join('\n') + '\n' : '');
}