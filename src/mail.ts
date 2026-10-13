import { graph } from './graph.js';
import type { EmailInput } from './classify.js';
import { CATEGORIES, type Category } from './taxonomy.js';

export type InboxMessage = {
  id: string;
  subject: string | null;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime: string;
  conversationId: string;
  body?: { contentType: string; content: string };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  attachments?: { name?: string; isInline?: boolean }[];
  categories?: string[];
  webLink?: string;
};

const NOISE_LINES = [
  /ce courriel provient de l.ext.rieur/i,
  /this email originated from outside/i,
  /ne cliquez pas sur les liens/i,
  /do not click links or open attachments/i,
  /^\s*\[?external( sender)?\]?\s*$/i,
];


// Texte brut + identifiants stables (les IDs changent sinon quand un message est déplacé)
export const PREFER = 'outlook.body-content-type="text", IdType="ImmutableId"';

/** Vérifie que le compte connecté est bien le bon. À appeler au démarrage. */
export async function assertMailbox(): Promise<string> {
  const expected = process.env.EXPECTED_MAILBOX?.toLowerCase();
  if (!expected) throw new Error('EXPECTED_MAILBOX manquant dans .env');

  const me = await graph<{ displayName: string; mail: string | null; userPrincipalName: string }>(
    '/me?$select=displayName,mail,userPrincipalName',
  );
  const actual = (me.mail ?? me.userPrincipalName).toLowerCase();
  if (actual !== expected) {
    throw new Error(
      `Mauvais compte connecté : ${actual} (attendu : ${expected}). Supprime .token-cache.json et reconnecte-toi.`,
    );
  }
  console.log(`Connecté : ${me.displayName} (${actual})`);
  return actual;
}

/** Courriels de la boîte de réception reçus depuis `sinceIso` (inclus), du plus ancien au plus récent. */
export async function fetchSince(sinceIso: string, max: number): Promise<InboxMessage[]> {
  const qs = [
    `$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}`,
    `$orderby=${encodeURIComponent('receivedDateTime asc')}`,
    '$select=id,subject,from,receivedDateTime,conversationId,body,toRecipients,ccRecipients,categories,webLink',
    '$top=25',
    '$expand=attachments($select=name,isInline)',
    
  ].join('&');

  const out: InboxMessage[] = [];
  let url: string | undefined = `/me/mailFolders/inbox/messages?${qs}`;
  while (url && out.length < max) {
    const page: { value: InboxMessage[]; '@odata.nextLink'?: string } = await graph(url, {
      headers: { Prefer: PREFER },
    });
    out.push(...page.value);
    url = page['@odata.nextLink'];
  }
  return out.slice(0, max);
}

// Marqueurs du début de l'historique cité (réponses et transferts)
const QUOTE_MARKERS = [
  /^-{2,}\s*(original message|message d['’]origine)/i,
  /^(from|de)\s*:\s*\S/i,
  /^(on|le)\s.+(wrote|a écrit)\s*:\s*$/i,
];

export function toEmailInput(m: InboxMessage): EmailInput {
  const { latest, quoted } = splitBody(m.body?.content ?? '');
  return {
    subject: m.subject ?? '(sans objet)',
    from: m.from?.emailAddress?.address ?? 'inconnu',
    receivedDateTime: m.receivedDateTime,
    bodyText: latest,
    quotedText: quoted,
    attachmentNames: (m.attachments ?? [])
      .filter((a) => !a.isInline)
      .map((a) => a.name ?? '')
      .filter((n) => n && !/^image\d*\.(png|jpe?g|gif)$/i.test(n)),
  };
}

function stripNoise(text: string): string {
  return text.split('\n').filter((l) => !NOISE_LINES.some((re) => re.test(l))).join('\n');
}

// Coupe la signature d'un collègue (configurable dans .env) pour que le message récent soit vraiment le message
function cutSignature(text: string): string {
  const src = process.env.SIGNATURE_CUT;
  if (!src) return text;
  const m = new RegExp(src, 'i').exec(text);
  return m ? text.slice(0, m.index).trim() : text;
}

export function splitBody(raw: string): { latest: string; quoted: string } {
  const text = stripNoise(raw.replace(/\r\n/g, '\n')).replace(/\n{3,}/g, '\n\n').trim();
  const lines = text.split('\n');
  const cut = lines.findIndex((l) => QUOTE_MARKERS.some((re) => re.test(l.trim())));
  if (cut < 0) return { latest: cutSignature(text), quoted: '' };
  return {
    latest: cutSignature(lines.slice(0, cut).join('\n').trim()),
    quoted: lines.slice(cut).join('\n').trim(),
  };
}

export function recipientsOf(m: InboxMessage): { to: string[]; cc: string[] } {
  const addrs = (l?: { emailAddress?: { address?: string } }[]) =>
    (l ?? []).map((a) => (a.emailAddress?.address ?? '').toLowerCase());
  return { to: addrs(m.toRecipients), cc: addrs(m.ccRecipients) };
}

export async function fetchHtmlBody(id: string): Promise<string> {
  const m = await graph<{ body?: { content?: string } }>(
    `/me/messages/${encodeURIComponent(id)}?$select=body`,
    { headers: { Prefer: 'outlook.body-content-type="html", IdType="ImmutableId"' } },
  );
  return m.body?.content ?? '';
}

// Les trois catégories gérées par l'agent : les autres catégories que tu poses toi-même ne sont jamais touchées
const TARGETS = ['soumission', 'nouvelle_commande', 'suivi_commande'] as const;
const MANAGED_LABELS: string[] = TARGETS.map((c) => CATEGORIES[c].label);

/** Pose la catégorie Outlook correspondante. Idempotent : ne fait rien si déjà en place. */
export async function tagMessage(m: InboxMessage, category: Category): Promise<'posée' | 'inchangée' | 'ignorée'> {
  if (!(TARGETS as readonly string[]).includes(category)) return 'ignorée';
  const label = CATEGORIES[category].label;
  const current = m.categories ?? [];
  const next = [...current.filter((c) => !MANAGED_LABELS.includes(c)), label];
  if (next.length === current.length && next.every((c) => current.includes(c))) return 'inchangée';

  await graph(`/me/messages/${encodeURIComponent(m.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'IdType="ImmutableId"' },
    body: JSON.stringify({ categories: next }),
  });
  return 'posée';
}