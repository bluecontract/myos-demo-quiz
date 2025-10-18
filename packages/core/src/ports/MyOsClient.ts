import type { Choice } from '../domain/models';

type QuestionPayload = {
  questionId: string;
  category: string;
  level: 0 | 1 | 2;
  prompt: string;
  options: Record<Choice, string>;
};

type StartRoundRequest = {
  roundIndex: number;
  question: QuestionPayload;
};

type CompleteRoundRequest = {
  roundIndex: number;
  questionId: string;
  correctOption: Choice;
  explanation?: string;
};

export interface MyOsClient {
  startRound(sessionId: string, request: StartRoundRequest): Promise<void>;
  completeRound(sessionId: string, request: CompleteRoundRequest): Promise<void>;
}

export type { StartRoundRequest, CompleteRoundRequest, QuestionPayload };
