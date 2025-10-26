import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Logger } from '@aws-lambda-powertools/logger';
import type { Metrics } from '@aws-lambda-powertools/metrics';
import { createSigner, httpbis } from 'http-message-signatures';
import type { DynamoWebhookDeliveryStore } from '@myos-quiz/persistence-ddb';
import {
  MyOsWebhookVerifier,
  WebhookVerificationError,
  computeContentDigest
} from '@myos-quiz/webhook';

const { signMessage } = httpbis;

const baseEvent: APIGatewayProxyEventV2 = {
  version: '2.0',
  routeKey: 'POST /webhooks/myos',
  rawPath: '/webhooks/myos',
  rawQueryString: '',
  headers: {},
  requestContext: {
    accountId: 'local',
    apiId: 'local',
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
} as APIGatewayProxyEventV2;

const keyPair = generateKeyPairSync('ed25519');
const publicJwk = {
  ...(keyPair.publicKey.export({ format: 'jwk' }) as JsonWebKey),
  kid: 'test-key',
  use: 'sig'
};
const signerKey = createSigner(keyPair.privateKey, 'ed25519', publicJwk.kid);

function createDeliveryStoreMock(overrides: {
  hasSeen?: ReturnType<typeof vi.fn>;
  markHandled?: ReturnType<typeof vi.fn>;
} = {}) {
  const hasSeen = overrides.hasSeen ?? vi.fn().mockResolvedValue(false);
  const markHandled = overrides.markHandled ?? vi.fn().mockResolvedValue(true);
  return {
    store: {
      hasSeen,
      markHandled
    } as unknown as DynamoWebhookDeliveryStore,
    hasSeen,
    markHandled
  };
}

function createFetchMock() {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: {
          'cache-control': 'max-age=60',
          etag: '"test"'
        }
      })
    );
}

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    appendKeys: vi.fn(),
    getLevel: vi.fn(),
    setPersistentLogAttributes: vi.fn(),
    addContext: vi.fn(),
    logEventIfEnabled: vi.fn(),
    log: vi.fn(),
    setLogLevel: vi.fn(),
    injectLambdaContext: vi.fn(),
    removeKeys: vi.fn()
  } as unknown as Logger;
}

function createMetrics(): Metrics {
  return {
    addMetric: vi.fn(),
    setDefaultDimensions: vi.fn(),
    publishStoredMetrics: vi.fn(),
    captureColdStartMetric: vi.fn(),
    throwOnEmptyMetrics: vi.fn(),
    reset: vi.fn()
  } as unknown as Metrics;
}

async function createSignedEvent(options: {
  deliveryId?: string;
  timestamp?: number;
  body?: Record<string, unknown>;
} = {}) {
  const payload = options.body ?? { hello: 'world' };
  const body = JSON.stringify(payload);
  const rawBody = Buffer.from(body, 'utf8');
  const digest = computeContentDigest(rawBody);
  const deliveryId = options.deliveryId ?? 'delivery-1';
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);

  const headers: Record<string, string> = {
    host: 'example.com',
    'x-forwarded-proto': 'https',
    'content-digest': digest,
    'x-myos-delivery-id': deliveryId,
    'x-myos-timestamp': timestamp.toString()
  };

  const signed = await signMessage(
    {
      key: signerKey,
      fields: [
        '"@method"',
        '"@target-uri"',
        '"content-digest"',
        '"x-myos-delivery-id"',
        '"x-myos-timestamp"'
      ],
      params: ['created', 'keyid', 'alg'],
      paramValues: {
        created: new Date(timestamp * 1000),
        keyid: publicJwk.kid,
        alg: 'ed25519'
      }
    },
    {
      method: 'POST',
      url: 'https://example.com/webhooks/myos',
      headers
    }
  );

  const signedHeaders = signed.headers as Record<string, string>;

  const event: APIGatewayProxyEventV2 = {
    ...baseEvent,
    body,
    headers: signedHeaders
  };

  return { event, rawBody, deliveryId };
}

describe('MyOsWebhookVerifier', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('verifies digest, timestamp, and signature for a valid webhook', async () => {
    const { event, rawBody, deliveryId } = await createSignedEvent();
    const { store: deliveryStore, hasSeen } = createDeliveryStoreMock();
    const fetchImpl = createFetchMock();
    const verifier = new MyOsWebhookVerifier({
      jwksUrl: 'https://example.com/jwks.json',
      toleranceSeconds: 300,
      replayTtlSeconds: 3600,
      deliveryStore,
      logger: createLogger(),
      metrics: createMetrics(),
      fetchImpl
    });

    const result = await verifier.verify(event, rawBody);

    expect(result).toEqual({ deliveryId, duplicate: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(hasSeen).toHaveBeenCalledWith(deliveryId);
  });

  it('marks duplicate deliveries when the store has seen the ID', async () => {
    const { event, rawBody, deliveryId } = await createSignedEvent();
    const { store: deliveryStore } = createDeliveryStoreMock({
      hasSeen: vi.fn().mockResolvedValue(true)
    });
    const verifier = new MyOsWebhookVerifier({
      jwksUrl: 'https://example.com/jwks.json',
      toleranceSeconds: 300,
      replayTtlSeconds: 3600,
      deliveryStore,
      logger: createLogger(),
      metrics: createMetrics(),
      fetchImpl: createFetchMock()
    });

    const result = await verifier.verify(event, rawBody);
    expect(result).toEqual({ deliveryId, duplicate: true });
  });

  it('throws when the Content-Digest header mismatches', async () => {
    const { event, rawBody } = await createSignedEvent();
    event.headers = {
      ...event.headers,
      'content-digest': 'sha-256=:bogus:'
    };
    const verifier = new MyOsWebhookVerifier({
      jwksUrl: 'https://example.com/jwks.json',
      toleranceSeconds: 300,
      replayTtlSeconds: 3600,
      deliveryStore: createDeliveryStoreMock().store,
      logger: createLogger(),
      metrics: createMetrics(),
      fetchImpl: createFetchMock()
    });

    await expect(verifier.verify(event, rawBody)).rejects.toMatchObject({
      reason: 'invalid_content_digest'
    });
  });

  it('throws when the timestamp is outside the allowed window', async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 1000;
    const { event, rawBody } = await createSignedEvent({ timestamp: oldTimestamp });
    const verifier = new MyOsWebhookVerifier({
      jwksUrl: 'https://example.com/jwks.json',
      toleranceSeconds: 60,
      replayTtlSeconds: 3600,
      deliveryStore: createDeliveryStoreMock().store,
      logger: createLogger(),
      metrics: createMetrics(),
      fetchImpl: createFetchMock()
    });

    await expect(verifier.verify(event, rawBody)).rejects.toMatchObject({
      reason: 'timestamp_out_of_window'
    });
  });

  it('throws when the HTTP signature is invalid', async () => {
    const { event, rawBody } = await createSignedEvent();
    event.headers = {
      ...event.headers,
      signature: 'myos=:ZmFrZVNpZw==:'
    };
    const verifier = new MyOsWebhookVerifier({
      jwksUrl: 'https://example.com/jwks.json',
      toleranceSeconds: 300,
      replayTtlSeconds: 3600,
      deliveryStore: createDeliveryStoreMock().store,
      logger: createLogger(),
      metrics: createMetrics(),
      fetchImpl: createFetchMock()
    });

    await expect(verifier.verify(event, rawBody)).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it('persists delivery IDs via markDelivered', async () => {
    const { store: deliveryStore, markHandled } = createDeliveryStoreMock();
    const verifier = new MyOsWebhookVerifier({
      jwksUrl: 'https://example.com/jwks.json',
      toleranceSeconds: 300,
      replayTtlSeconds: 3600,
      deliveryStore,
      logger: createLogger(),
      metrics: createMetrics(),
      fetchImpl: createFetchMock()
    });

    await verifier.markDelivered('delivery-xyz');
    expect(markHandled).toHaveBeenCalledWith('delivery-xyz', 3600);
  });
});
