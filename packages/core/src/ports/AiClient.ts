import type { GeneratedQuestion } from '../domain/models';

export interface GenerateQuestionInput {
  categories: string[];
  level: 0 | 1 | 2;
  metadata?: {
    sessionId?: string;
    roundIndex?: number;
  };
}

export interface AiClient {
  generateQuestion(input: GenerateQuestionInput): Promise<GeneratedQuestion>;
}
