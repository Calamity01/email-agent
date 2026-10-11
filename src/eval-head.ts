import { promises as fs } from 'node:fs';
import { extractSubjectHead } from './refs.js';

type Meta = { subject: string | null };

function shuffle<T>(items: T[], seed: number): T[] {
  let a = seed;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function main() {
  const index: Meta[] = JSON.parse(await fs.readFile('eval/archive-index.json', 'utf8'));
  const subjects = index.map((m) => m.subject ?? '').filter(Boolean);
  const hits = subjects.filter((s) => extractSubjectHead(s));
  console.log(`${hits.length}/${subjects.length} objets (${((100 * hits.length) / subjects.length).toFixed(0)} %) produisent un numéro en tête.\n`);

  console.log('70 exemples au hasard (numéro retenu | objet) :');
  for (const s of shuffle(hits, 5).slice(0, 70)) {
    console.log(`  ${extractSubjectHead(s)!.value.padEnd(16)} | ${s.slice(0, 70)}`);
  }

  const misses = subjects.filter((s) => !extractSubjectHead(s) && /^\s*(?:(?:re|tr|fw|fwd)\s*:\s*)*\S*\d{3}/i.test(s));
  console.log('\n25 objets dont le premier mot contient 3 chiffres mais sans numéro retenu :');
  for (const s of shuffle(misses, 7).slice(0, 25)) console.log(`  ${s.slice(0, 80)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});