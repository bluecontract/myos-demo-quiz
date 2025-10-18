import type {
  MyOsClient,
  StartRoundRequest,
  CompleteRoundRequest
} from '@myos-quiz/core';
import { fetch as undiciFetch } from 'undici';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HttpMyOsClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
}

export class HttpMyOsClient implements MyOsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchFn;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: HttpMyOsClientOptions) {
    if (!options.baseUrl) {
      throw new Error('MYOS_BASE_URL must be configured');
    }
    if (!options.apiKey) {
      throw new Error('MYOS_API_KEY must be configured');
    }

    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    const fetchCandidate =
      options.fetchImpl ??
      (typeof fetch === 'function' ? fetch : undefined) ??
      ((undiciFetch as unknown) as typeof fetch);
    this.fetchImpl = fetchCandidate as FetchFn;
    this.defaultHeaders = {
      'content-type': 'application/json',
      Accept: 'application/json',
      Authorization: this.apiKey,
      ...options.defaultHeaders
    };
  }

  async startRound(sessionId: string, request: StartRoundRequest): Promise<void> {
    await this.postOperation(sessionId, 'startRound', request);
  }

  async completeRound(sessionId: string, request: CompleteRoundRequest): Promise<void> {
    await this.postOperation(sessionId, 'completeRound', request);
  }

  private async postOperation(
    sessionId: string,
    operation: string,
    payload: unknown
  ): Promise<void> {
    const url = `${this.baseUrl}/documents/${encodeURIComponent(sessionId)}/${operation}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        ...this.defaultHeaders
      },
      body: JSON.stringify(payload)
    });

    await this.ensureOkResponse(response, sessionId, operation);
  }

  private async ensureOkResponse(response: Response, sessionId: string, operation: string) {
    if (response.status >= 200 && response.status < 300) {
      return;
    }

    const payload = await response.text();
    const error = new Error(
      `MyOS operation ${operation} for session ${sessionId} failed with ${response.status}`
    );
    (error as Error & { cause?: unknown }).cause = payload;
    throw error;
  }
}
