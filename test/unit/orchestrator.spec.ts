import { describe, expect, it, vi } from 'vitest';
import {
  Orchestrator,
  type DocumentSnapshot,
  type AiClient,
  type MyOsClient,
  type QuestionRepo,
  QuestionAlreadyExistsError
} from '@myos-quiz/core';

const buildSnapshot = (overrides: Partial<DocumentSnapshot>): DocumentSnapshot => ({
  sessionId: 'sess-123',
  roundIndex: 0,
  level: 1,
  categories: ['History'],
  emitted: [],
  ...overrides
});

describe('Orchestrator', () => {
  it('generates a new round when Round Requested is emitted', async () => {
    const ai: AiClient = {
      generateQuestion: vi.fn().mockResolvedValue({
        questionId: 'q-1',
        category: 'History',
        prompt: 'Who?',
        options: {
          A: 'One',
          B: 'Two',
          C: 'Three',
          D: 'Four'
        },
        correctOption: 'A',
        explanation: 'Because'
      })
    };

    const repo: QuestionRepo = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined)
    };

    const myos: MyOsClient = {
      startRound: vi.fn().mockResolvedValue(undefined),
      completeRound: vi.fn().mockResolvedValue(undefined)
    };

    const orchestrator = new Orchestrator(ai, myos, repo);

    const snapshot = buildSnapshot({
      emitted: [{ type: 'Round Requested', nextRoundIndex: 2 }],
      level: 2,
      categories: ['Science']
    });

    await orchestrator.onDocumentUpdated(snapshot);

    expect(ai.generateQuestion).toHaveBeenCalledWith({
      categories: ['Science'],
      level: 2,
      metadata: {
        sessionId: 'sess-123',
        roundIndex: 2
      }
    });
    expect(repo.put).toHaveBeenCalledWith('sess-123', 2, {
      questionId: 'q-1',
      correctOption: 'A',
      explanation: 'Because'
    });
    expect(myos.startRound).toHaveBeenCalledWith('sess-123', {
      roundIndex: 2,
      question: {
        questionId: 'q-1',
        category: 'History',
        level: 2,
        prompt: 'Who?',
        options: {
          A: 'One',
          B: 'Two',
          C: 'Three',
          D: 'Four'
        }
      }
    });
  });

  it('completes the round when both answers are present', async () => {
    const ai: AiClient = {
      generateQuestion: vi.fn()
    };

    const repo: QuestionRepo = {
      get: vi.fn().mockResolvedValue({
        questionId: 'q-2',
        correctOption: 'C',
        explanation: 'Because'
      }),
      put: vi.fn()
    };

    const myos: MyOsClient = {
      startRound: vi.fn(),
      completeRound: vi.fn().mockResolvedValue(undefined)
    };

    const orchestrator = new Orchestrator(ai, myos, repo);

    const snapshot = buildSnapshot({
      phase: 'IN_ROUND',
      answers: {
        playerA: { choice: 'A' },
        playerB: { choice: 'B' }
      }
    });

    await orchestrator.onDocumentUpdated(snapshot);

    expect(repo.get).toHaveBeenCalledWith('sess-123', 0);
    expect(myos.completeRound).toHaveBeenCalledWith('sess-123', {
      roundIndex: 0,
      questionId: 'q-2',
      correctOption: 'C',
      explanation: 'Because'
    });
  });

  it('completes the round when players submit the same choice', async () => {
    const repo: QuestionRepo = {
      get: vi.fn().mockResolvedValue({
        questionId: 'q-3',
        correctOption: 'A',
        explanation: 'Same answer'
      }),
      put: vi.fn()
    };

    const myos: MyOsClient = {
      startRound: vi.fn(),
      completeRound: vi.fn().mockResolvedValue(undefined)
    };

    const orchestrator = new Orchestrator(
      { generateQuestion: vi.fn() } as AiClient,
      myos,
      repo
    );

    const snapshot = buildSnapshot({
      phase: 'IN_ROUND',
      answers: {
        playerA: { choice: 'A' },
        playerB: { choice: 'A' }
      }
    });

    await orchestrator.onDocumentUpdated(snapshot);

    expect(repo.get).toHaveBeenCalledWith('sess-123', 0);
    expect(myos.completeRound).toHaveBeenCalledWith('sess-123', {
      roundIndex: 0,
      questionId: 'q-3',
      correctOption: 'A',
      explanation: 'Same answer'
    });
  });

  it('ignores duplicate round requests when repo signals conflict', async () => {
    const ai: AiClient = {
      generateQuestion: vi.fn().mockResolvedValue({
        questionId: 'q-1',
        category: 'History',
        prompt: 'Prompt',
        options: {
          A: 'One',
          B: 'Two',
          C: 'Three',
          D: 'Four'
        },
        correctOption: 'A'
      })
    };

    const repo: QuestionRepo = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockRejectedValue(new QuestionAlreadyExistsError('sess-123', 1))
    };

    const myos: MyOsClient = {
      startRound: vi.fn(),
      completeRound: vi.fn()
    };

    const orchestrator = new Orchestrator(ai, myos, repo);

    const snapshot = buildSnapshot({
      emitted: [{ type: 'Round Requested', nextRoundIndex: 1 }]
    });

    await orchestrator.onDocumentUpdated(snapshot);

    expect(myos.startRound).not.toHaveBeenCalled();
  });
});
