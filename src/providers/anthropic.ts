import Anthropic from '@anthropic-ai/sdk';
import { CLASSIFICATION_JSON_SCHEMA } from '../taxonomy.js';

let client: Anthropic | undefined;

export async function callAnthropic(system: string, userContent: string): Promise<unknown> {
  client ??= new Anthropic(); // lit ANTHROPIC_API_KEY
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';

  const response = await client.messages.create({
    model,
    max_tokens: 600,
    temperature: 0,
    system,
    tools: [
      {
        name: 'classify_email',
        description: 'Enregistre la classification du courriel.',
        input_schema: CLASSIFICATION_JSON_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: 'classify_email' },
    messages: [{ role: 'user', content: userContent }],
  });

  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!block) throw new Error('Anthropic : aucune classification retournée');
  return block.input;
}