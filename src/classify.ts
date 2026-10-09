import 'dotenv/config';
import { callAnthropic } from './providers/anthropic.js';
import { callOpenAI } from './providers/openai.js';
import {
  ClassificationSchema,
  SYSTEM_PROMPT,
  formatEmail,
  type Classification,
  type EmailInput,
  FIELDS_MODE,
} from './taxonomy.js';
import { refineCategory } from './fields.js';

export { CATEGORIES } from './taxonomy.js';
export type { Category, Classification, EmailInput } from './taxonomy.js';
// Notification Zoho : un collègue a préparé une soumission (Quote ou Deal) que tu dois finaliser
const ZOHO_QUOTE_NOTIFICATION = /mentioned you in a comment on\s+(quote|deal)\b/i;

function getProvider(): 'anthropic' | 'openai' {
  const p = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  if (p !== 'anthropic' && p !== 'openai') {
    throw new Error(`LLM_PROVIDER invalide : "${p}" (valeurs permises : anthropic, openai)`);
  }
  return p;
}

export async function classifyEmail(email: EmailInput): Promise<Classification> {
  if (
    email.from.toLowerCase() === 'notifications@zohocrm.com' &&
    ZOHO_QUOTE_NOTIFICATION.test(email.subject)
  ) {
    return {
      category: 'soumission',
      urgency: 'normale',
      requires_reply: false,
      language: 'en',
      summary: 'Notification Zoho : soumission préparée par un collègue, à valider (prix, délais).',
      entities: { client: null, project_number: null, order_number: null },
      confidence: 'elevee',
    };
  }
  const forced = (process.env.FORCE_AUTRE_SENDERS ?? '').toLowerCase().split(/[,\s;]+/).filter(Boolean);
  if (forced.includes(email.from.toLowerCase())) {
    return {
      category: 'autre',
      urgency: 'normale',
      requires_reply: false,
      language: 'autre',
      summary: 'Expéditeur classé « autre » par règle locale.',
      entities: { client: null, project_number: null, order_number: null },
      confidence: 'elevee',
    };
  }
  const userContent = formatEmail(email);
  const raw =
    getProvider() === 'openai'
      ? await callOpenAI(SYSTEM_PROMPT, userContent)
      : await callAnthropic(SYSTEM_PROMPT, userContent);

  // Validation indépendante du fournisseur : on ne fait jamais confiance à la sortie brute
  const result = ClassificationSchema.parse(raw);
  if (FIELDS_MODE) {
    result.model_category = result.category;       // ce que le modèle aurait choisi lui-même
    result.category = refineCategory(result).category;      // la catégorie vient de la table de décision
  }
  return result;
}