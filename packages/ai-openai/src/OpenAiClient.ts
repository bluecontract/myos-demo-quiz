import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFormatTextJSONSchemaConfig
} from 'openai/resources/responses/responses';
import { QuestionSchema } from './schema';
import type { AiClient, GenerateQuestionInput } from '@myos-quiz/core';
import type { GeneratedQuestion, Choice } from '@myos-quiz/core';

export interface OpenAiClientConfig {
  client?: OpenAI;
  defaultModel?: string;
}

export class OpenAiClient implements AiClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private lastResponseId?: string;

  constructor(config: OpenAiClientConfig = {}) {
    const apiKey = config.client ? undefined : process.env.OPENAI_API_KEY;

    if (!config.client && !apiKey) {
      throw new Error('OPENAI_API_KEY is required to instantiate OpenAiClient');
    }

    this.client = config.client ?? new OpenAI({ apiKey });
    this.model = config.defaultModel ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  }

  async generateQuestion(input: GenerateQuestionInput): Promise<GeneratedQuestion> {
    const difficulty = ['easy', 'medium', 'hard'][input.level] ?? 'easy';
    const instructions = [
      'You are an assistant that writes exactly one multiple-choice trivia question.',
      'Use one of the provided categories and ensure four distinct options labelled A, B, C, D.',
      'Return JSON only that conforms to the provided schema.',
      `Difficulty: ${difficulty}. Avoid ambiguity, ensure a single definitive correct answer.`,
      'Vary topics between prompts to keep gameplay fresh.'
    ].join(' ');

    const payload: ResponseCreateParamsNonStreaming = {
      model: this.model,
      input: [
        { role: 'system', content: instructions },
        {
          role: 'user',
          content: `Categories available: ${input.categories.join(', ') || 'General Knowledge'}`
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: QuestionSchema.name,
          schema: QuestionSchema.schema as Record<string, unknown>,
          strict: QuestionSchema.strict
        } satisfies ResponseFormatTextJSONSchemaConfig
      }
      // Alternative: use tools/function-calling with strict: true if migration is needed.
      // tools: [{ type: 'function', function: { name: QuestionSchema.name, parameters: QuestionSchema.schema, strict: true } }]
    };

    const response = await this.client.responses.create(payload);

    this.lastResponseId = response.id;

    const parsed = this.parseResponse(response);
    this.assertOptions(parsed.options);
    return parsed;
  }

  private parseResponse(response: Response): GeneratedQuestion {
    if (response.output_text) {
      return JSON.parse(response.output_text) as GeneratedQuestion;
    }

    for (const item of response.output ?? []) {
      const contentItems =
        ((item as { content?: Array<{ type: string; text?: string | null; json?: unknown }> }).content) ?? [];

      for (const piece of contentItems) {
        if (piece.type === 'output_text' && piece.text) {
          return JSON.parse(piece.text) as GeneratedQuestion;
        }
        if ('json' in piece && piece.json) {
          return piece.json as GeneratedQuestion;
        }
        if (piece.text) {
          try {
            return JSON.parse(piece.text) as GeneratedQuestion;
          } catch {
            // continue scanning other pieces
          }
        }
      }
    }

    throw new Error('OpenAI response missing structured content');
  }

  private assertOptions(options: Record<Choice, string>): void {
    const required: Choice[] = ['A', 'B', 'C', 'D'];
    for (const key of required) {
      if (!options?.[key] || typeof options[key] !== 'string') {
        throw new Error(`OpenAI response missing option ${key}`);
      }
    }

    const values = new Set(Object.values(options));
    if (values.size !== required.length) {
      throw new Error('OpenAI response options must be distinct');
    }
  }

  getLastResponseId(): string | undefined {
    return this.lastResponseId;
  }
}
