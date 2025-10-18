import { ChoiceSchema } from '../domain/models';
import type { DocumentSnapshot } from '../domain/models';
import { RoundRequestedEventSchema } from '../domain/events';
import type { RoundRequestedEvent } from '../domain/events';
import type { AiClient } from '../ports/AiClient';
import type { MyOsClient } from '../ports/MyOsClient';
import type { QuestionRepo, QuestionAlreadyExistsError } from '../ports/QuestionRepo';

const DEFAULT_CATEGORY = 'General Knowledge';

export interface OrchestratorLogger {
  debug(message: string, context?: Record<string, unknown>): void;
}

export class Orchestrator {
  constructor(
    private readonly ai: AiClient,
    private readonly myos: MyOsClient,
    private readonly repo: QuestionRepo,
    private readonly logger?: OrchestratorLogger
  ) {}

  async onDocumentUpdated(snapshot: DocumentSnapshot): Promise<void> {
    const roundRequested = this.extractRoundRequested(snapshot);
    if (roundRequested) {
      await this.handleRoundRequested(snapshot, roundRequested);
      return;
    }

    if (this.shouldCompleteRound(snapshot)) {
      await this.handleRoundCompletion(snapshot);
    }
  }

  private extractRoundRequested(snapshot: DocumentSnapshot): RoundRequestedEvent | null {
    if (!snapshot.emitted) {
      return null;
    }

    for (const event of snapshot.emitted) {
      const parsed = RoundRequestedEventSchema.safeParse(event);
      if (parsed.success) {
        return parsed.data;
      }
    }

    return null;
  }

  private async handleRoundRequested(
    snapshot: DocumentSnapshot,
    event: RoundRequestedEvent
  ): Promise<void> {
    const roundIndex = event.nextRoundIndex ?? snapshot.roundIndex ?? 0;
    const sessionId = snapshot.sessionId;

    const existing = await this.repo.get(sessionId, roundIndex);
    if (existing) {
      this.logger?.debug('Round request skipped: question already stored', {
        sessionId,
        roundIndex
      });
      return;
    }

    const categories = snapshot.categories?.length ? snapshot.categories : [DEFAULT_CATEGORY];
    const level = snapshot.level ?? 0;

    const generated = await this.ai.generateQuestion({
      categories,
      level,
      metadata: {
        sessionId,
        roundIndex
      }
    });

    try {
      await this.repo.put(sessionId, roundIndex, {
        questionId: generated.questionId,
        correctOption: generated.correctOption,
        explanation: generated.explanation
      });
    } catch (error) {
      if (this.isQuestionAlreadyExistsError(error, sessionId, roundIndex)) {
        return;
      }
      throw error;
    }

    await this.myos.startRound(sessionId, {
      roundIndex,
      question: {
        questionId: generated.questionId,
        category: generated.category ?? categories[0] ?? DEFAULT_CATEGORY,
        level,
        prompt: generated.prompt,
        options: generated.options
      }
    });
  }

  private shouldCompleteRound(snapshot: DocumentSnapshot): boolean {
    if (snapshot.phase !== 'IN_ROUND') {
      return false;
    }

    const answers = snapshot.answers;
    if (!answers) {
      return false;
    }

    const players = new Set<string>();

    for (const [player, value] of Object.entries(answers as Record<string, unknown>)) {
      if (value === null || value === undefined) {
        continue;
      }

      let candidate: unknown = value;
      if (typeof value === 'object' && value !== null && 'choice' in value) {
        candidate = (value as { choice?: unknown }).choice;
      }

      const parsed = ChoiceSchema.safeParse(candidate);
      if (parsed.success) {
        players.add(player);
      }
    }

    return players.size >= 2;
  }

  private async handleRoundCompletion(snapshot: DocumentSnapshot): Promise<void> {
    const sessionId = snapshot.sessionId;
    const roundIndex = snapshot.roundIndex;
    const stored = await this.repo.get(sessionId, roundIndex);

    if (!stored) {
      this.logger?.debug('Round completion skipped: question not found', {
        sessionId,
        roundIndex
      });
      return;
    }

    const questionId = stored.questionId || snapshot.currentQuestion?.questionId || '';

    await this.myos.completeRound(sessionId, {
      roundIndex,
      questionId,
      correctOption: stored.correctOption,
      explanation: stored.explanation
    });
  }

  private isQuestionAlreadyExistsError(
    error: unknown,
    sessionId: string,
    roundIndex: number
  ): error is QuestionAlreadyExistsError {
    return (
      typeof error === 'object' &&
      error !== null &&
      'sessionId' in error &&
      'roundIndex' in error &&
      (error as QuestionAlreadyExistsError).sessionId === sessionId &&
      (error as QuestionAlreadyExistsError).roundIndex === roundIndex
    );
  }
}
