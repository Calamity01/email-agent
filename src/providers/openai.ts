import OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import { CLASSIFICATION_JSON_SCHEMA } from '../taxonomy.js';

let client: OpenAI | undefined;

export type CallOpts = {
  name?: string;
  schema?: { type: 'object';[k: string]: unknown };
  maxTokens?: number;
};

// Modèles de raisonnement (gpt-5…, o1, o3…) : pas de temperature, mais reasoning_effort possible.
const isReasoningModel = (model: string) => /^(gpt-5|o\d)/.test(model);

export async function callOpenAI(system: string, userContent: string, opts: CallOpts = {}): Promise<unknown> {
  client ??= new OpenAI(); // lit OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL ?? 'gpt-5-mini';
  const effort = process.env.OPENAI_REASONING_EFFORT as ReasoningEffort | undefined;

  const modelParams = isReasoningModel(model)
    ? effort ? { reasoning_effort: effort } : {}
    : { temperature: 0 };

  const completion = await client.chat.completions.create({
    model,
    max_completion_tokens: opts.maxTokens ?? 2000,
    ...modelParams,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: opts.name ?? 'email_classification',
        strict: true,
        schema: opts.schema ?? CLASSIFICATION_JSON_SCHEMA,
      },
    },
  });

  const message = completion.choices[0]?.message;
  if (message?.refusal) throw new Error(`OpenAI : refus du modèle (${message.refusal})`);
  if (!message?.content) throw new Error('OpenAI : réponse vide');
  return JSON.parse(message.content);
}