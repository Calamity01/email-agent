import { senderKind, type Category, type Classification } from './taxonomy.js';
import { refineCategory, refineCategoryV1 } from './fields.js';

export type Ctx = { from: string; to: string[]; cc: string[]; me: string; subject?: string };
export type Opts = {
  refine?: boolean;
  po?: boolean;
  cc?: boolean;
  rules?: 'v1' | 'v2';
  gabarit?: boolean;
};

const PO_SUBJECT =
  /^\s*((re|fw|fwd|tr)\s*:\s*)*(commande d'achat standard|a purchase order|purchase order)/i;

/** Choix du modèle + règles déterministes (chacune peut être désactivée pour mesurer son effet). */
export function finalCategory(
  c: Classification,
  ctx: Ctx,
  opts: Opts = {},
): { category: Category; rule: string } {
  const { refine = true, po = true, cc = true, rules = 'v1', gabarit = false } = opts;
  let category: Category = c.category;
  let rule = 'modèle';

  // 1. Filtres issus des champs
  if (refine) ({ category, rule } = (rules === 'v1' ? refineCategoryV1 : refineCategory)(c));

  // 2. Un bon de commande REÇU d'un expéditeur externe est une commande de client
  if (po && c.act === 'commande' && senderKind(ctx.from) === null && category !== 'nouvelle_commande') {
    category = 'nouvelle_commande';
    rule = "bon de commande reçu d'un expéditeur externe";
  }

  // 3. Gabarit d'objet « Commande d'achat standard… » (à mesurer sur run4)
  if (
    gabarit &&
    PO_SUBJECT.test(ctx.subject ?? '') &&
    senderKind(ctx.from) !== 'fournisseur' &&
    category !== 'nouvelle_commande'
  ) {
    category = 'nouvelle_commande';
    rule = "gabarit de bon de commande";
  }

  // 4. Tu n'es qu'en copie : rien à faire pour toi
  const me = ctx.me.toLowerCase();
  if (cc && !ctx.to.includes(me) && ctx.cc.includes(me)) {
    category = 'autre';
    rule = 'en copie (Cc) seulement';
  }
  return { category, rule };
}