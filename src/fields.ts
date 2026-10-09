import { z } from 'zod';
import type { Category } from './taxonomy.js';

export const SENDER_ROLES = ['client', 'collegue', 'fournisseur', 'tiers', 'systeme'] as const;
export const ACTS = ['demande', 'commande', 'information'] as const;
export const TOPICS = [
  'nouvel_achat',
  'commande_client_en_cours',
  'soumission_en_cours',
  'commande_fournisseur',
  'sav_retour',
  'technique',
  'autre',
] as const;

export const FieldsSchema = z.object({
  sender_role: z.enum(SENDER_ROLES).optional(),
  act: z.enum(ACTS).optional(),
  topic: z.enum(TOPICS).optional(),
  client_demand: z.boolean().optional(),
});
export type Fields = z.infer<typeof FieldsSchema>;

export const FIELD_PROPS = {
  sender_role: { type: 'string', enum: [...SENDER_ROLES], description: 'Qui écrit le message à classifier.' },
  act: { type: 'string', enum: [...ACTS], description: 'Ce que fait le message à classifier.' },
  topic: { type: 'string', enum: [...TOPICS], description: 'De quoi parle le message.' },
  client_demand: {
    type: 'boolean',
    description: "true si le message concerne ou relaie une demande d'un client qui attend une réponse.",
  },
};
export const FIELD_REQUIRED = ['sender_role', 'act', 'topic', 'client_demand'];

/** Table de décision : c'est ici que vivent tes règles. */
export function explainCategory(f: Fields): { category: Category; rule: string } {
  const { sender_role: role, act, topic } = f;
  if (!role || !act || !topic) return { category: 'autre', rule: '0 champ manquant' };
  if (role === 'systeme' || role === 'fournisseur' || role === 'tiers') {
    return { category: 'autre', rule: `1 rôle=${role}` };
  }
  if (['commande_fournisseur', 'sav_retour', 'technique', 'soumission_en_cours', 'autre'].includes(topic)) {
    return { category: 'autre', rule: `2 sujet=${topic}` };
  }
  if (role === 'collegue' && f.client_demand !== true) {
    return { category: 'autre', rule: '3 collègue sans demande de client' };
  }
  if (act === 'commande') return { category: 'nouvelle_commande', rule: '4 act=commande' };
  if (act === 'demande' && topic === 'nouvel_achat') return { category: 'soumission', rule: '5 demande + nouvel_achat' };
  if (act === 'demande' && topic === 'commande_client_en_cours') {
    return { category: 'suivi_commande', rule: '6 demande + commande_client_en_cours' };
  }
  return { category: 'autre', rule: `7 sinon (act=${act}, sujet=${topic})` };
}

export function deriveCategory(f: Fields): Category {
  return explainCategory(f).category;
}

/** Catégorie du modèle, corrigée par les deux seules règles qui ont fait leurs preuves. */
export function refineCategory(f: Fields & { category: Category }): { category: Category; rule: string } {
  const c = f.category;
  if (c === 'soumission' || c === 'suivi_commande') {
    if (f.act === 'information') return { category: 'autre', rule: 'le message ne fait qu\'informer' };
    if (f.topic === 'soumission_en_cours') return { category: 'autre', rule: 'relance de soumission' };
  }
  return { category: c, rule: 'modèle' };
}