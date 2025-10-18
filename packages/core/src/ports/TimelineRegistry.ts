export interface TimelineRegistry {
  /**
   * Returns true if these timelineIds are allowed for this sessionId (registered or consistent).
   * When false is returned the caller should skip processing.
   */
  checkAndRegister(timelineIds: string[], sessionId: string, ttlHours?: number): Promise<boolean>;
}
