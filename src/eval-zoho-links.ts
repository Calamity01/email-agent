import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { graph } from './graph.js';
import { assertMailbox } from './mail.js';
import { extractZohoIds } from './zoho.js';

type Meta = { id: string; subject: string | null; from?: { emailAddress?: { address?: string } } };

async function body(id: string, type: 'text' | 'html'): Promise<string> {
  const m = await graph<{ body?: { content?: string } }>(
    `/me/messages/${encodeURIComponent(id)}?$select=body`,
    { headers: { Prefer: `outlook.body-content-type="${type}", IdType="ImmutableId"` } },
  );
  return m.body?.content ?? '';
}

async function main() {
  await assertMailbox();
  const index: Meta[] = JSON.parse(await fs.readFile('eval/archive-index.json', 'utf8'));
  const notifs = index.filter(
    (m) =>
      m.from?.emailAddress?.address?.toLowerCase() === 'notifications@zohocrm.com' &&
      /mentioned you in a comment on/i.test(m.subject ?? ''),
  );
  console.log(`${notifs.length} notifications Zoho de mention dans l'archive.\n`);

  let inText = 0, inHtml = 0, tested = 0;
  for (const m of notifs.slice(0, 10)) {
    const text = await body(m.id, 'text');
    const html = await body(m.id, 'html');
    const t = extractZohoIds(text);
    const h = extractZohoIds(html);
    tested++;
    if (t.length) inText++;
    if (h.length) inHtml++;
    const fmt = (l: typeof t) => l.map((r) => `${r.kind}=${r.value}`).join(', ') || '—';
    console.log((m.subject ?? '').slice(0, 70));
    console.log(`   texte brut : ${fmt(t)} | HTML : ${fmt(h)}`);
    if (!t.length && !h.length) {
      const link = html.match(/https?:[^"'\s<>]{0,100}zoho[^"'\s<>]{0,100}/i)?.[0] ?? 'aucun lien zoho trouvé';
      console.log(`   (aucun identifiant : premier lien zoho = ${link})`);
    }
  }
  console.log(`\nSur ${tested} notifications : identifiant trouvé dans le texte brut ${inText}, dans le HTML ${inHtml}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});