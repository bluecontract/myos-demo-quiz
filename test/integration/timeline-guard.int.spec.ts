import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { handler, __setAppContextFactory } from '@myos-quiz/webhook';
import type { TimelineRegistry } from '@myos-quiz/core';
import { loadMyosFixtureResolved, loadMyosFixtureResolvedJson } from '../fixtures/myos';


const baseEvent: Omit<APIGatewayProxyEventV2, 'body'> = {
  version: '2.0',
  routeKey: 'POST /webhooks/myos',
  rawPath: '/webhooks/myos',
  rawQueryString: '',
  headers: {},
  requestContext: {
    accountId: 'test',
    apiId: 'test',
    domainName: 'example.com',
    domainPrefix: 'example',
    http: {
      method: 'POST',
      path: '/webhooks/myos',
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'vitest'
    },
    requestId: 'req-id',
    routeKey: 'POST /webhooks/myos',
    stage: '$default',
    time: '',
    timeEpoch: Date.now()
  },
  isBase64Encoded: false
};

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

function createWebhookVerifierMock() {
  return {
    verify: vi.fn().mockResolvedValue({ deliveryId: 'verify-123', duplicate: false }),
    markDelivered: vi.fn().mockResolvedValue(undefined)
  };
}

describe('Timeline guard integration', () => {
  beforeEach(() => {
    process.env.APP_NAME = 'myos-quiz';
    process.env.STAGE = 'test';
    process.env.CONTROL_TABLE_NAME = 'MyosQuizControl';
  });

  afterEach(() => {
    __setAppContextFactory(() => {
      throw new Error('App context factory should be set within each test');
    });
  });

  it('skips orchestrator when timeline is already bound to another session', async () => {
    const snapshotBody = loadMyosFixtureResolved('document-updated-event_round-requested.json');
    const firstEvent: APIGatewayProxyEventV2 = {
      ...baseEvent,
      body: snapshotBody
    };

    const secondPayload = JSON.parse(snapshotBody);
    secondPayload.object.sessionId = 'conflicting-session';
    const secondEvent: APIGatewayProxyEventV2 = {
      ...baseEvent,
      body: JSON.stringify(secondPayload)
    };

    const orchestrator = {
      onDocumentUpdated: vi.fn().mockResolvedValue(undefined)
    };
    const checkAndRegister = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const timelineRegistry: TimelineRegistry = {
      checkAndRegister
    };

    __setAppContextFactory(async () => ({
      orchestrator: orchestrator as unknown as { onDocumentUpdated: typeof orchestrator.onDocumentUpdated },
      repo: {} as unknown,
      ai: {} as unknown,
      myos: {} as unknown,
      stage: 'test',
      appName: 'myos-quiz',
      timelineRegistry,
      timelineGuardTtlHours: 48,
      webhookVerifier: createWebhookVerifierMock()
    }));

    const firstResponse = await handler(firstEvent, baseContext);
    expect(firstResponse.statusCode).toBe(200);
    expect(orchestrator.onDocumentUpdated).toHaveBeenCalledTimes(1);
    expect(checkAndRegister.mock.calls[0]).toMatchInlineSnapshot(`
      [
        [
          "a90f6e2c-9988-4bfa-b634-b4378e398475",
          "98c52bf0-453d-432e-a06b-8825ffcb308a",
          "b1a3dec4-6a5a-4f51-807e-d7635b83b939",
        ],
        "c9de5ea2-d8b0-4cac-96c8-049856e8e8f2",
        48,
      ]
    `)

    const secondResponse = await handler(secondEvent, baseContext);
    expect(secondResponse.statusCode).toBe(200);
    expect(orchestrator.onDocumentUpdated).toHaveBeenCalledTimes(1);
    expect(checkAndRegister).toHaveBeenCalledTimes(2);
    expect(checkAndRegister.mock.calls[1]).toMatchInlineSnapshot(`
      [
        [
          "a90f6e2c-9988-4bfa-b634-b4378e398475",
          "98c52bf0-453d-432e-a06b-8825ffcb308a",
          "b1a3dec4-6a5a-4f51-807e-d7635b83b939",
        ],
        "conflicting-session",
        48,
      ]
    `)
  });

  it('skips processing when timeline channels are missing', async () => {
    const payload = loadMyosFixtureResolvedJson('document-updated-event_round-requested.json');
    delete payload.object.document.contracts.adminChannel.timelineId;
    delete payload.object.document.contracts.playerAChannel.timelineId;
    delete payload.object.document.contracts.playerBChannel.timelineId;

    const event: APIGatewayProxyEventV2 = {
      ...baseEvent,
      body: JSON.stringify(payload)
    };

    const orchestrator = {
      onDocumentUpdated: vi.fn()
    };
    const checkAndRegister = vi.fn();

    __setAppContextFactory(async () => ({
      orchestrator: orchestrator as unknown as { onDocumentUpdated: typeof orchestrator.onDocumentUpdated },
      repo: {} as unknown,
      ai: {} as unknown,
      myos: {} as unknown,
      stage: 'test',
      appName: 'myos-quiz',
      timelineRegistry: { checkAndRegister } as TimelineRegistry,
      timelineGuardTtlHours: 48,
      webhookVerifier: createWebhookVerifierMock()
    }));

    const response = await handler(event, baseContext);
    expect(response.statusCode).toBe(200);
    expect(orchestrator.onDocumentUpdated).not.toHaveBeenCalled();
    expect(checkAndRegister).not.toHaveBeenCalled();
  });
});
