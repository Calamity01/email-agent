import { promises as fs } from 'node:fs';
import { parseCsv, toCsv } from './csv.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const tag = arg('tag', 'run2');
  const file = arg('file', '');
  const to = arg('to', '');
  const lines = arg('lines', '').split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
  const apply = process.argv.includes('--apply');
  if (!file || !to || lines.length === 0) {
    throw new Error('Usage : --file Classeur5.csv --lines 7,9,12 --to suivi_commande [--apply]');
  }

  // Fichier des désaccords sans en-tête : colonne 2 = expéditeur, colonne 3 = objet
  const src = parseCsv(await fs.readFile(file, 'utf8'));

  const labelPath = `eval/${tag}.to-label.csv`;
  const [head, ...rows] = parseCsv(await fs.readFile(labelPath, 'utf8'));
  const cFrom = head.indexOf('de');
  const cSubj = head.indexOf('objet');
  const cMine = head.indexOf('ma_categorie');
  if ([cFrom, cSubj, cMine].some((c) => c < 0)) throw new Error('Colonnes de / objet / ma_categorie introuvables');

  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  let changed = 0;

  for (const n of lines) {
    const s = src[n - 1];
    if (!s) { console.log(`Ligne ${n} : absente de ${file}`); continue; }
    const from = norm(s[1] ?? '');
    const subject = norm(s[2] ?? '');
    const matches = rows.filter((r) => norm(r[cFrom] ?? '') === from && norm(r[cSubj] ?? '') === subject);
    if (matches.length !== 1) {
      console.log(`Ligne ${n} : ${matches.length} correspondances pour « ${s[2]} » (${s[1]}). Ignorée : modifie-la à la main.`);
      continue;
    }
    const row = matches[0];
    while (row.length <= cMine) row.push('');
    console.log(`Ligne ${n} : « ${(row[cSubj] ?? '').slice(0, 60)} » (${row[cFrom]}) : « ${row[cMine] || '(vide)'} » → « ${to} »`);
    row[cMine] = to;
    changed++;
  }

  if (!apply) {
    console.log(`\nAperçu seulement (${changed} modification(s)). Ajoute --apply pour écrire.`);
    return;
  }
  await fs.copyFile(labelPath, `${labelPath}.bak-${Date.now()}`);
  await fs.writeFile(labelPath, toCsv([head, ...rows]));
  console.log(`\n${changed} étiquette(s) modifiée(s). Une sauvegarde a été créée à côté du fichier.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});