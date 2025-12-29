import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { TimelineRegistry } from '@myos-quiz/core';
import { handler, __setAppContextFactory } from '@myos-quiz/webhook';
import { loadMyosFixtureResolved } from '../fixtures/myos';

const rawMyosPayload = loadMyosFixtureResolved('document-updated-event_round-requested.json');

const baseEvent: APIGatewayProxyEventV2 = {
  version: '2.0',
  routeKey: 'POST /webhooks/myos',
  rawPath: '/webhooks/myos',
  rawQueryString: '',
  headers: {},
  requestContext: {
    accountId: 'local',
    apiId: 'local',
    domainName: 'localhost',
    domainPrefix: 'local',
    http: {
      method: 'POST',
      path: '/webhooks/myos',
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'vitest'
    },
    requestId: 'req-123',
    routeKey: 'POST /webhooks/myos',
    stage: '$default',
    time: '',
    timeEpoch: Date.now()
  },
  isBase64Encoded: false
} as APIGatewayProxyEventV2;

const baseContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'test',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:region:123:function:test',
  memoryLimitInMB: '128',
  awsRequestId: 'aws-request-id',
  logGroupName: '/aws/lambda/test',
  logStreamName: '2024/01/01/[$LATEST]123',
  getRemainingTimeInMillis: () => 1000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined
};

function createWebhookVerifierMock(result?: { deliveryId?: string; duplicate?: boolean }) {
  const resolved = {
    deliveryId: result?.deliveryId ?? 'verify-123',
    duplicate: result?.duplicate ?? false
  };
  return {
    verify: vi.fn().mockResolvedValue(resolved),
    markDelivered: vi.fn().mockResolvedValue(undefined)
  };
}

describe('webhook handler – MyOS payload', () => {
  beforeEach(() => {
    process.env.APP_NAME = 'myos-quiz';
    process.env.STAGE = 'test';
    process.env.LOG_LEVEL = 'WARN';
    process.env.CONTROL_TABLE_NAME = 'MyosQuizControl';
  });

  afterEach(() => {
    __setAppContextFactory(() => {
      throw new Error('App context factory should be set by each test case');
    });
  });

  it('normalizes DOCUMENT_EPOCH_ADVANCED payload into orchestrator snapshot', async () => {
    const onDocumentUpdated = vi.fn().mockResolvedValue(undefined);

    __setAppContextFactory(async () => ({
      orchestrator: { onDocumentUpdated } as unknown as { onDocumentUpdated: typeof onDocumentUpdated },
      repo: {} as unknown,
      ai: {} as unknown,
      myos: {} as unknown,
      stage: 'test',
      appName: 'myos-quiz',
      timelineRegistry: {
        checkAndRegister: vi.fn().mockResolvedValue(true)
      } as TimelineRegistry,
      timelineGuardTtlHours: 48,
      webhookVerifier: createWebhookVerifierMock()
    }));

    const response = await handler(
      {
        ...baseEvent,
        body: rawMyosPayload
      },
      baseContext
    );

    expect(response.statusCode).toBe(200);
    expect(onDocumentUpdated).toHaveBeenCalledTimes(1);
    const snapshot = onDocumentUpdated.mock.calls[0][0];
    expect(snapshot.sessionId).toEqual(expect.any(String));
    expect(snapshot.roundIndex).toBe(0);
    expect(snapshot.categories).toEqual(['History', 'Science']);
    expect(snapshot.emitted?.length).toBeGreaterThan(0);
    expect(snapshot.emitted?.[0]).toMatchObject({ type: 'Core/Document Processing Initiated' });
    expect(snapshot.emitted?.[2]).toMatchObject({
      type: 'Round Requested',
      kind: 'Round Requested',
      nextRoundIndex: 0
    });
  });

  it('returns 200 when payload cannot be normalized', async () => {
    const onDocumentUpdated = vi.fn();

    __setAppContextFactory(async () => ({
      orchestrator: { onDocumentUpdated } as unknown as { onDocumentUpdated: typeof onDocumentUpdated },
      repo: {} as unknown,
      ai: {} as unknown,
      myos: {} as unknown,
      stage: 'test',
      appName: 'myos-quiz',
      timelineRegistry: {
        checkAndRegister: vi.fn().mockResolvedValue(true)
      } as TimelineRegistry,
      timelineGuardTtlHours: 48,
      webhookVerifier: createWebhookVerifierMock()
    }));

    const response = await handler(
      {
        ...baseEvent,
        body: JSON.stringify({ type: 'DOCUMENT_EPOCH_ADVANCED', object: {} })
      },
      baseContext
    );

    expect(response.statusCode).toBe(200);
    expect(onDocumentUpdated).not.toHaveBeenCalled();
  });

  it('skips orchestrator work when webhook verification reports a duplicate', async () => {
    const onDocumentUpdated = vi.fn();
    const webhookVerifier = createWebhookVerifierMock({ duplicate: true, deliveryId: 'dup-1' });

    __setAppContextFactory(async () => ({
      orchestrator: { onDocumentUpdated } as unknown as { onDocumentUpdated: typeof onDocumentUpdated },
      repo: {} as unknown,
      ai: {} as unknown,
      myos: {} as unknown,
      stage: 'test',
      appName: 'myos-quiz',
      timelineRegistry: {
        checkAndRegister: vi.fn().mockResolvedValue(true)
      } as TimelineRegistry,
      timelineGuardTtlHours: 48,
      webhookVerifier
    }));

    const response = await handler(
      {
        ...baseEvent,
        body: rawMyosPayload
      },
      baseContext
    );

    expect(response.statusCode).toBe(200);
    expect(onDocumentUpdated).not.toHaveBeenCalled();
    expect(webhookVerifier.markDelivered).not.toHaveBeenCalled();
  });
});
