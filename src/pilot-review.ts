import { promises as fs } from 'node:fs';
import { toCsv } from './csv.js';

type Rel = { subject: string; link: string };

async function main() {
  const lines = (await fs.readFile('data/classifications.jsonl', 'utf8')).split('\n').filter((l) => l.trim());
  const entries = lines.map((l) => JSON.parse(l));
  const targets = entries.filter((e) => e.classification && e.classification.category !== 'autre');
  console.log(`${entries.length} courriels journalisés, dont ${targets.length} classés soumission / commande / suivi.`);

  const byCat: Record<string, number> = {};
  for (const e of targets) byCat[e.classification.category] = (byCat[e.classification.category] ?? 0) + 1;
  console.table(byCat);

  const funnel: Record<string, number> = {};
  for (const e of targets.filter((x) => x.classification.category === 'suivi_commande')) {
    const k = e.pilot?.reason ?? '(pilote non exécuté)';
    funnel[k] = (funnel[k] ?? 0) + 1;
  }
  console.log('\nSuivis : où chaque courriel s\'arrête');
  console.table(funnel);

  const contextOf = (e: any): Rel[] => {
    if (!e.related) return [];
    const byRef = Object.values(e.related.byRef as Record<string, Rel[]>).flat();
    return [...byRef, ...(e.related.thread as Rel[])];
  };
  const withRelated = targets.filter((e) => e.related);
  const found = withRelated.filter((e) => contextOf(e).length > 0);
  console.log(`\nContexte retrouvé (fil ou référence) : ${found.length}/${withRelated.length}`);

  const rows = targets.map((e) => {
    const ctx = contextOf(e);
    return [
      (e.receivedDateTime ?? '').slice(0, 10),
      e.from ?? '',
      e.subject ?? '',
      e.classification.category,
      e.pilot ? `${e.pilot.action} : ${e.pilot.reason}` : '',
      String(ctx.length),
      ctx[0] ? `${ctx[0].subject} | ${ctx[0].link}` : '',
      '', // utile (o/n)
    ];
  });
  await fs.writeFile(
    'data/revue.csv',
    toCsv([['date', 'de', 'objet', 'categorie', 'pilote', 'nb_contexte', 'premier_contexte', 'utile (o/n)'], ...rows]),
  );
  console.log('\nFeuille de revue : data/revue.csv');
}

main().catch((e) => { console.error(e); process.exit(1); });