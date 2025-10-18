import type { Choice } from '../domain/models';

export interface StoredQuestion {
  questionId: string;
  correctOption: Choice;
  explanation?: string;
}

export class QuestionAlreadyExistsError extends Error {
  public readonly sessionId: string;
  public readonly roundIndex: number;

  constructor(sessionId: string, roundIndex: number) {
    super(`Question already exists for session ${sessionId} round ${roundIndex}`);
    this.sessionId = sessionId;
    this.roundIndex = roundIndex;
  }
}

export interface QuestionRepo {
  put(sessionId: string, roundIndex: number, data: StoredQuestion): Promise<void>;
  get(sessionId: string, roundIndex: number): Promise<StoredQuestion | null>;
}
