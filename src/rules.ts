import { senderKind, type Category, type Classification } from './taxonomy.js';
import { refineCategory } from './fields.js';

export type Ctx = { from: string; to: string[]; cc: string[]; me: string };

/** Choix du modèle + règles déterministes. Servira à classify.ts et à eval-compare. */
export function finalCategory(c: Classification, ctx: Ctx): { category: Category; rule: string } {
  // 1. Filtres issus des champs (message qui ne fait qu'informer, relance de soumission)
  let { category, rule } = refineCategory(c);

  // 2. Un bon de commande REÇU d'un expéditeur externe est une commande de client
  if (c.act === 'commande' && senderKind(ctx.from) === null && category !== 'nouvelle_commande') {
    category = 'nouvelle_commande';
    rule = 'bon de commande reçu d\'un expéditeur externe';
  }

  // 3. Tu n'es qu'en copie : rien à faire pour toi
  const me = ctx.me.toLowerCase();
  if (!ctx.to.includes(me) && ctx.cc.includes(me)) {
    category = 'autre';
    rule = 'en copie (Cc) seulement';
  }
  return { category, rule };
}