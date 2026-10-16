import 'dotenv/config';
import { graph } from './graph.js';
import { applyOutlookChange, type Urgency } from './mail.js';
import { categoryIds, type Category } from './taxonomy.js';

type Status = 'inbox' | 'archive' | 'deleted' | 'other';
type State = { status: Status; repliedAt?: string };
type Pending = { id: number; messageId: string; field: string; newValue: string };
const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' };
let lastSync = 0;
let folders: { inbox: string; archive: string; deleted: string } | undefined;
// Dernières dates de réponse déjà envoyées au backend (évite de les renvoyer à chaque passage)
const sentReplies = new Map<string, string>();
const base = () => (process.env.TRIAGE_API_URL ?? '').replace(/\/+$/, '');
const URGENCIES = ['basse', 'normale', 'haute'];

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.TRIAGE_API_KEY ?? '',
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`API ${res.status} sur ${path}`);
  return res.json() as Promise<T>;
}

async function folderIds() {
  if (folders) return folders;
  const id = async (name: string) =>
    (await graph<{ id: string }>(`/me/mailFolders/${name}?$select=id`)).id;
  folders = { inbox: await id('inbox'), archive: await id('archive'), deleted: await id('deleteditems') };
  return folders;
}

// 0x1081 = dernière action faite sur le message (102 répondre, 103 répondre à tous, 104 transférer)
// 0x1082 = date de cette action
const PROPS = "singleValueExtendedProperties($filter=id eq 'Integer 0x1081' or id eq 'SystemTime 0x1082')"
  .replace(/ /g, '%20');

type BatchResp = {
  responses: {
    id: string;
    status: number;
    body?: {
      parentFolderId?: string;
      singleValueExtendedProperties?: { id: string; value: string }[];
    };
  }[];
};

function repliedAtOf(props: { id: string; value: string }[] | undefined): string | undefined {
  if (!props) return undefined;
  const verb = props.find((p) => /0x1081/i.test(p.id))?.value;
  if (verb !== '102' && verb !== '103') return undefined; // un transfert (104) n'est pas une réponse
  const date = props.find((p) => /0x1082/i.test(p.id))?.value;
  const t = date ? Date.parse(date) : NaN;
  // Date absente (rare) : on prend l'instant de la détection, faute de mieux
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

/** Dossier actuel et date de réponse de chaque courriel, par lots de 20 (limite de $batch). */
async function currentStates(ids: string[]): Promise<Map<string, State>> {
  const f = await folderIds();
  const out = new Map<string, State>();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const res = await graph<BatchResp>('/$batch', {
      method: 'POST',
      body: JSON.stringify({
        requests: chunk.map((id, k) => ({
          id: String(k),
          method: 'GET',
          url: `/me/messages/${encodeURIComponent(id)}?$select=parentFolderId&$expand=${PROPS}`,
          headers: IMMUTABLE,
        })),
      }),
    });
    for (const r of res.responses) {
      const id = chunk[Number(r.id)];
      if (r.status === 404) out.set(id, { status: 'deleted' }); // supprimé définitivement
      else if (r.status === 200) {
        const p = r.body?.parentFolderId;
        out.set(id, {
          status: p === f.inbox ? 'inbox' : p === f.archive ? 'archive' : p === f.deleted ? 'deleted' : 'other',
          repliedAt: repliedAtOf(r.body?.singleValueExtendedProperties),
        });
      }
      // tout autre code (429, 5xx…) : on réessaie au prochain passage
    }
  }
  return out;
}

type Update = { messageId: string; status?: Status; repliedAt?: string };

/** À appeler à chaque cycle : ne fait quelque chose que toutes les SYNC_STATUS_MIN minutes (15 par défaut). */
export async function syncStatusIfDue(): Promise<void> {
  if (!process.env.TRIAGE_API_URL) return;
  const everyMs = Number(process.env.SYNC_STATUS_MIN ?? 15) * 60_000;
  if (Date.now() - lastSync < everyMs) return;
  lastSync = Date.now(); // même en cas d'échec : on ne martèle pas le serveur
  try { await pushChangesToOutlook(); } 
  catch (e) { console.error('Poussée vers Outlook :', e instanceof Error ? e.message : e); }
  const days = Number(process.env.SYNC_SINCE_DAYS ?? 45);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const open = await api<{ items: { messageId: string }[]; total: number; truncated: boolean }>(
    `/open?status=inbox&limit=500&since=${encodeURIComponent(since)}`,
  );
  if (open.truncated) console.warn(`Synchro des statuts : ${open.total} fiches ouvertes, seules 500 sont vérifiées.`);
  if (open.items.length === 0) return;

  const states = await currentStates(open.items.map((i) => i.messageId));
  const updates: Update[] = [];
  for (const [messageId, s] of states) {
    const u: Update = { messageId };
    if (s.status !== 'inbox') u.status = s.status;
    if (s.repliedAt && sentReplies.get(messageId) !== s.repliedAt) u.repliedAt = s.repliedAt;
    if (u.status || u.repliedAt) updates.push(u);
  }

  for (let i = 0; i < updates.length; i += 200) {
    const chunk = updates.slice(i, i + 200);
    await api('/status', { method: 'POST', body: JSON.stringify({ updates: chunk }) });
    for (const u of chunk) if (u.repliedAt) sentReplies.set(u.messageId, u.repliedAt);
  }
  if (updates.length) {
    const count: Record<string, number> = {};
    for (const u of updates) if (u.status) count[u.status] = (count[u.status] ?? 0) + 1;
    const replies = updates.filter((u) => u.repliedAt).length;
    console.log(`Synchro : statuts ${JSON.stringify(count)}, réponses détectées ${replies} (sur ${open.items.length} vérifiés)`);
  }
}

async function pushChangesToOutlook(): Promise<void> {
  const { items } = await api<{ items: Pending[] }>('/outlook-pending?limit=500');
  if (items.length === 0) return;

  const byMsg = new Map<string, Pending[]>();
  for (const it of items) byMsg.set(it.messageId, [...(byMsg.get(it.messageId) ?? []), it]);

  const done: number[] = [];
  for (const [messageId, rows] of byMsg) {
    rows.sort((a, b) => a.id - b.id); // la dernière valeur gagne
    const ch: { category?: Category; urgency?: Urgency } = {};
    for (const r of rows) {
      if (r.field === 'category' && categoryIds.includes(r.newValue as Category)) ch.category = r.newValue as Category;
      if (r.field === 'urgency' && URGENCIES.includes(r.newValue)) ch.urgency = r.newValue as Urgency;
    }
    try {
      await applyOutlookChange(messageId, ch);
      done.push(...rows.map((r) => r.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Graph 404/.test(msg)) done.push(...rows.map((r) => r.id)); // courriel supprimé : inutile de réessayer
      else console.error(`Outlook : échec pour ${messageId} : ${msg}`); // réessayé au prochain passage
    }
  }

  for (let i = 0; i < done.length; i += 200) {
    await api('/outlook-done', { method: 'POST', body: JSON.stringify({ ids: done.slice(i, i + 200) }) });
  }
  if (done.length) console.log(`Outlook mis à jour : ${done.length} changement(s) appliqué(s)`);
}