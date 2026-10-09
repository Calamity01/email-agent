import { promises as fs } from 'node:fs';

type Meta = {
  subject: string | null;
  from?: { emailAddress?: { address?: string } };
};

const EN = /mentioned you in a comment on\s+(\w+)/i;
const FR = /vous a mentionn\S*\s+dans un commentaire\s+(?:sur|dans)\s+(?:le |la |l['’])?(\w+)/i;

async function main() {
  const index: Meta[] = JSON.parse(await fs.readFile('eval/archive-index.json', 'utf8'));

  const byType = new Map<string, { n: number; example: string }>();
  const senders = new Set<string>();
  let total = 0;

  for (const m of index) {
    const subject = m.subject ?? '';
    const hit = EN.exec(subject) ?? FR.exec(subject);
    if (!hit) continue;
    total++;
    const type = hit[1].toLowerCase();
    const entry = byType.get(type) ?? { n: 0, example: subject };
    entry.n++;
    byType.set(type, entry);
    const from = m.from?.emailAddress?.address?.toLowerCase();
    if (from && /zoho/i.test(from)) senders.add(from);
  }

  console.log(`${total} notifications de mention trouvées sur ${index.length} courriels.\n`);
  console.log('Par type d\'objet :');
  for (const [type, { n, example }] of [...byType].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${String(n).padStart(5)}  ${type.padEnd(14)} ex. : ${example.slice(0, 80)}`);
  }

  console.log(`\nExpéditeurs de ces notifications : ${[...senders].join(', ') || '(aucun)'}`);

  const others = index.filter((m) => {
    const from = m.from?.emailAddress?.address?.toLowerCase();
    const s = m.subject ?? '';
    return from && senders.has(from) && !EN.test(s) && !FR.test(s);
  });
  console.log(`\nAutres courriels de ces mêmes expéditeurs : ${others.length}. Exemples d'objets :`);
  for (const m of others.slice(0, 15)) console.log(`  - ${(m.subject ?? '').slice(0, 90)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});