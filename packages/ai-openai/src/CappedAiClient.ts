import type { AiClient, GenerateQuestionInput } from '@myos-quiz/core';
import type { RateLimiter } from '@myos-quiz/core';

export class CappedAiClient implements AiClient {
  private lastCallState: 'real' | 'mock_force' | 'mock_limit' | undefined;

  constructor(
    private readonly realClient: AiClient,
    private readonly mockClient: AiClient,
    private readonly limiter: RateLimiter,
    private readonly maxPerHour?: number,
    private readonly forceMock?: boolean
  ) {}

  async generateQuestion(input: GenerateQuestionInput) {
    if (this.forceMock) {
      this.lastCallState = 'mock_force';
      return this.mockClient.generateQuestion(input);
    }

    if (!this.maxPerHour || this.maxPerHour <= 0) {
      this.lastCallState = 'real';
      return this.realClient.generateQuestion(input);
    }

    const allowed = await this.limiter.tryConsume({
      budget: 'openai',
      windowSeconds: 3600,
      limit: this.maxPerHour
    });

    if (allowed) {
      this.lastCallState = 'real';
      return this.realClient.generateQuestion(input);
    }

    this.lastCallState = 'mock_limit';
    return this.mockClient.generateQuestion(input);
  }

  getLastResponseId(): string | undefined {
    const candidate = this.realClient as unknown as {
      getLastResponseId?: () => string | undefined;
    };
    return candidate.getLastResponseId?.();
  }

  wasLastCallMock(): boolean {
    return this.lastCallState === 'mock_force' || this.lastCallState === 'mock_limit';
  }

  getLastCallReason(): 'force' | 'limit' | undefined {
    if (this.lastCallState === 'mock_force') {
      return 'force';
    }
    if (this.lastCallState === 'mock_limit') {
      return 'limit';
    }
    return undefined;
  }
}
