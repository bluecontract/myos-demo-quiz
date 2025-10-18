import { createHash } from 'node:crypto';
import type { AiClient, GenerateQuestionInput } from '@myos-quiz/core';
import type { Choice, GeneratedQuestion } from '@myos-quiz/core';

const OPTIONS: Record<Choice, string> = {
  A: 'Mock A',
  B: 'Mock B',
  C: 'Mock C',
  D: 'Mock D'
};

const CHOICES: Choice[] = ['A', 'B', 'C', 'D'];

export interface OpenAiMockClientOptions {
  seed?: string;
}

export class OpenAiMockClient implements AiClient {
  private readonly seed: string;

  constructor(options: OpenAiMockClientOptions = {}) {
    this.seed = options.seed ?? 'myos-quiz';
  }

  async generateQuestion(input: GenerateQuestionInput): Promise<GeneratedQuestion> {
    const key = buildKey(input, this.seed);
    const hash = createHash('sha256').update(key).digest('hex');
    const category = pickCategory(hash, input.categories);
    const correctOption = CHOICES[parseInt(hash.slice(0, 2), 16) % CHOICES.length];

    return {
      questionId: `mock-${hash.slice(0, 16)}`,
      category,
      prompt: `[MOCK] Which option is correct for ${category} (level ${input.level})?`,
      options: { ...OPTIONS },
      correctOption,
      explanation: 'Mocked due to budget cap or MOCK_OPENAI.'
    };
  }
}

function buildKey(input: GenerateQuestionInput, seed: string): string {
  const sessionId = input.metadata?.sessionId;
  const roundIndex =
    input.metadata?.roundIndex !== undefined ? String(input.metadata.roundIndex) : undefined;

  if (sessionId && roundIndex) {
    return `${sessionId}:${roundIndex}:${seed}`;
  }

  const categories = input.categories.length ? input.categories.join('|') : 'general';
  return `${categories}:${input.level}:${seed}`;
}

function pickCategory(hash: string, categories: string[]): string {
  if (!categories || categories.length === 0) {
    return 'General Knowledge';
  }

  const idx = parseInt(hash.slice(2, 6), 16) % categories.length;
  return categories[idx] || 'General Knowledge';
}
