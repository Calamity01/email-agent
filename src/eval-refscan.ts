import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { CATEGORIES, toActive, type Category } from './taxonomy.js';
import { toEmailInput, type InboxMessage } from './mail.js';
import { extractInternal, type Where } from './refs.js';
import { parseCsv } from './csv.js';

const norm = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
const byName = new Map<string, Category>();
for (const [id, c] of Object.entries(CATEGORIES)) {
  byName.set(norm(id), id as Category);
  byName.set(norm(c.label), id as Category);
}

const TAGS = ['run2', 'run3', 'run4'];

async function main() {
  const table: Record<string, Record<string, number>> = {};
  for (const tag of TAGS) {
    const [head, ...data] = parseCsv(await fs.readFile(`eval/${tag}.to-label.csv`, 'utf8'));
    const cId = head.indexOf('id');
    const cMine = head.indexOf('ma_categorie');
    const messages: Record<string, InboxMessage> = JSON.parse(
      await fs.readFile(`eval/${tag}.messages.json`, 'utf8'),
    );
    let att: Record<string, string[]> = {};
    try { att = JSON.parse(await fs.readFile(`eval/${tag}.attachments.json`, 'utf8')); } catch { /* absent */ }

    for (const r of data) {
      const raw = (r[cMine] ?? '').trim() || 'autre';
      if (/^(ambigu|\?)$/i.test(raw)) continue;
      const original = byName.get(norm(raw));
      const m = messages[r[cId]];
      if (!original || !m) continue;
      const input = toEmailInput(m);
      const refs = extractInternal({
        objet: input.subject,
        message: input.bodyText,
        piece_jointe: (att[r[cId]] ?? []).join('\n'),
        historique: input.quotedText ?? '',
      }).filter((x) => x.kind !== 'item_interne');
      const row = (table[toActive(original)] ??= {
        courriels: 0, 'avec réf interne': 0,
        'dans l\'objet': 0, 'dans le message': 0, 'pièce jointe': 0, 'historique seul': 0,
        vso: 0, scom: 0, emd: 0, emq: 0,
      });
      row.courriels++;
      if (refs.length === 0) continue;
      row['avec réf interne']++;
      const best = (['objet', 'message', 'piece_jointe', 'historique'] as Where[])
        .find((w) => refs.some((x) => x.where === w));
      const label = { objet: "dans l'objet", message: 'dans le message', piece_jointe: 'pièce jointe', historique: 'historique seul' }[best!];
      row[label]++;
      for (const k of new Set(refs.map((x) => x.kind))) if (k in row) row[k]++;
    }
  }
  console.table(table);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});