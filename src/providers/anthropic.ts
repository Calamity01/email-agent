import Anthropic from '@anthropic-ai/sdk';
import { CLASSIFICATION_JSON_SCHEMA } from '../taxonomy.js';

let client: Anthropic | undefined;

export type CallOpts = {
  name?: string;
  schema?: { type: 'object';[k: string]: unknown };
  maxTokens?: number;
};

export async function callAnthropic(system: string, userContent: string, opts: CallOpts = {}): Promise<unknown> {
  client ??= new Anthropic(); // lit ANTHROPIC_API_KEY
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
  const name = opts.name ?? 'classify_email';

  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 600,
    temperature: 0,
    system,
    tools: [
      {
        name,
        description: opts.name ? 'Enregistre le résultat.' : 'Enregistre la classification du courriel.',
        input_schema: opts.schema ?? CLASSIFICATION_JSON_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name },
    messages: [{ role: 'user', content: userContent }],
  });

  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!block) throw new Error('Anthropic : aucun résultat retourné');
  return block.input;
}