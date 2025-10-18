export interface RateLimiter {
  /** Returns true if a token was consumed and caller may proceed with real call. */
  tryConsume(opts: {
    budget: 'openai';
    windowSeconds: number;
    limit: number;
    now?: Date;
  }): Promise<boolean>;
}
