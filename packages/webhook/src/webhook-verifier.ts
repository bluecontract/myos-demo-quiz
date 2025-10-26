import { createHash, createPublicKey, type JsonWebKey as NodeJsonWebKey } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Logger } from '@aws-lambda-powertools/logger';
import type { Metrics } from '@aws-lambda-powertools/metrics';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { httpbis, createVerifier, UnknownKeyError, type VerifyingKey } from 'http-message-signatures';
import { fetch as undiciFetch } from 'undici';
import type { DynamoWebhookDeliveryStore } from '@myos-quiz/persistence-ddb';

const { verifyMessage } = httpbis;

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

type HeaderMap = Map<string, string>;

export interface WebhookVerificationOptions {
  jwksUrl: string;
  toleranceSeconds: number;
  replayTtlSeconds: number;
  deliveryStore: DynamoWebhookDeliveryStore;
  logger: Logger;
  metrics: Metrics;
  fetchImpl?: typeof fetch;
}

export interface VerificationOutcome {
  deliveryId: string;
  duplicate: boolean;
}

export class WebhookVerificationError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly statusCode = 401
  ) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export class MyOsWebhookVerifier {
  private readonly fetchImpl: typeof fetch;
  private readonly jwksCache: JwksKeyCache;

  constructor(private readonly options: WebhookVerificationOptions) {
    const tolerance = options.toleranceSeconds;
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      throw new Error('toleranceSeconds must be a positive number');
    }
    const replayTtl = options.replayTtlSeconds;
    if (!Number.isFinite(replayTtl) || replayTtl <= 0) {
      throw new Error('replayTtlSeconds must be a positive number');
    }

    this.fetchImpl =
      options.fetchImpl ??
      (typeof fetch === 'function' ? fetch : ((undiciFetch as unknown) as typeof fetch));
    this.jwksCache = new JwksKeyCache({
      jwksUrl: options.jwksUrl,
      fetchImpl: this.fetchImpl,
      logger: options.logger
    });
  }

  async verify(event: APIGatewayProxyEventV2, rawBody: Buffer): Promise<VerificationOutcome> {
    const headers = normalizeHeaders(event.headers);
    const contentDigest = headers.get('content-digest');
    if (!contentDigest) {
      this.options.metrics.addMetric('webhook_missing_digest', MetricUnit.Count, 1);
      throw new WebhookVerificationError('Missing Content-Digest header', 'missing_content_digest', 400);
    }

    const computedDigest = computeContentDigest(rawBody);
    if (contentDigest !== computedDigest) {
      this.options.metrics.addMetric('webhook_digest_mismatch', MetricUnit.Count, 1);
      throw new WebhookVerificationError('Invalid Content-Digest header', 'invalid_content_digest', 400);
    }

    const timestampHeader = headers.get('x-myos-timestamp');
    const timestamp = Number(timestampHeader);
    if (!timestampHeader || Number.isNaN(timestamp)) {
      this.options.metrics.addMetric('webhook_missing_timestamp', MetricUnit.Count, 1);
      throw new WebhookVerificationError(
        'Missing or invalid X-MyOS-Timestamp header',
        'missing_timestamp',
        400
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestamp) > this.options.toleranceSeconds) {
      this.options.metrics.addMetric('webhook_timestamp_out_of_window', MetricUnit.Count, 1);
      throw new WebhookVerificationError('Stale webhook timestamp', 'timestamp_out_of_window', 400);
    }

    const deliveryId = headers.get('x-myos-delivery-id');
    if (!deliveryId) {
      this.options.metrics.addMetric('webhook_missing_delivery_id', MetricUnit.Count, 1);
      throw new WebhookVerificationError(
        'Missing X-MyOS-Delivery-Id header',
        'missing_delivery_id',
        400
      );
    }

    const signatureInput = headers.get('signature-input');
    const signature = headers.get('signature');
    if (!signatureInput || !signature) {
      this.options.metrics.addMetric('webhook_missing_signature', MetricUnit.Count, 1);
      throw new WebhookVerificationError('Missing HTTP signature headers', 'missing_signature', 400);
    }

    await this.verifySignature(event, headers);
    this.options.metrics.addMetric('webhook_signature_verified', MetricUnit.Count, 1);

    const duplicate = await this.options.deliveryStore.hasSeen(deliveryId);
    if (duplicate) {
      this.options.logger.info('Detected duplicate MyOS webhook delivery', { deliveryId });
      this.options.metrics.addMetric('webhook_duplicate_delivery', MetricUnit.Count, 1);
    }

    return { deliveryId, duplicate };
  }

  async markDelivered(deliveryId: string): Promise<void> {
    const stored = await this.options.deliveryStore.markHandled(
      deliveryId,
      this.options.replayTtlSeconds
    );
    if (!stored) {
      this.options.logger.debug('Delivery already recorded in replay store', { deliveryId });
    }
  }

  private async verifySignature(
    event: APIGatewayProxyEventV2,
    headers: HeaderMap
  ): Promise<void> {
    const method = event.requestContext.http?.method ?? 'POST';
    const url = buildTargetUrl(event, headers);
    const headerObject = Object.fromEntries(headers);
    try {
      const verified = await verifyMessage(
        {
          keyLookup: async params => {
            const kidParam = params.keyid;
            const kid = typeof kidParam === 'string' ? kidParam : undefined;
            if (!kid) {
              throw new UnknownKeyError('Missing keyid');
            }
            const verifier = await this.jwksCache.get(kid);
            if (!verifier) {
              throw new UnknownKeyError(`Unknown key: ${kid}`);
            }
            return verifier;
          },
          requiredFields: [
            '@method',
            '@target-uri',
            'content-digest',
            'x-myos-delivery-id',
            'x-myos-timestamp'
          ],
          requiredParams: ['keyid', 'alg', 'created'],
          maxAge: this.options.toleranceSeconds,
          tolerance: 5
        },
        {
          method,
          url,
          headers: headerObject
        }
      );
      if (!verified) {
        throw new WebhookVerificationError('Unable to verify HTTP signature', 'signature_indeterminate');
      }
    } catch (error) {
      this.options.metrics.addMetric('webhook_signature_invalid', MetricUnit.Count, 1);
      if (error instanceof WebhookVerificationError) {
        throw error;
      }
      this.options.logger.error('HTTP signature verification failed', {
        error: serializeError(error)
      });
      throw new WebhookVerificationError('Invalid HTTP signature', 'invalid_signature');
    }
  }
}

class JwksKeyCache {
  private readonly keyCache = new Map<string, { key: VerifyingKey; expiresAt: number }>();
  private etag: string | undefined;
  private nextRefresh = 0;
  private maxAgeMs = DEFAULT_CACHE_TTL_MS;

  constructor(
    private readonly options: {
      jwksUrl: string;
      fetchImpl: typeof fetch;
      logger: Logger;
    }
  ) {}

  async get(kid: string): Promise<VerifyingKey | null> {
    const existing = this.keyCache.get(kid);
    const now = Date.now();
    if (existing && existing.expiresAt > now) {
      return existing.key;
    }

    await this.refresh();
    const refreshed = this.keyCache.get(kid);
    if (refreshed && refreshed.expiresAt > Date.now()) {
      return refreshed.key;
    }

    return null;
  }

  private async refresh(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.nextRefresh > now) {
      return;
    }

    const headers: Record<string, string> = {
      accept: 'application/jwk-set+json, application/json'
    };
    if (this.etag) {
      headers['if-none-match'] = this.etag;
    }

    let response: Response;
    try {
      response = await this.options.fetchImpl(this.options.jwksUrl, { headers });
    } catch (error) {
      this.options.logger.error('Failed to fetch MyOS JWKS', { error: serializeError(error) });
      throw new WebhookVerificationError('Unable to download MyOS JWKS', 'jwks_unreachable');
    }

    if (response.status === 304) {
      this.nextRefresh = now + this.maxAgeMs;
      this.bumpKeyExpiry(now + this.maxAgeMs);
      return;
    }

    if (!response.ok) {
      throw new WebhookVerificationError(
        `Unable to fetch JWKS (status ${response.status})`,
        'jwks_http_error'
      );
    }

    const payload = (await response.json()) as { keys?: MyOsJwk[] } | null;
    if (!payload?.keys || !Array.isArray(payload.keys)) {
      throw new WebhookVerificationError('JWKS payload missing keys array', 'jwks_invalid');
    }

    const cacheControl = response.headers.get('cache-control');
    const parsedMaxAge = parseMaxAge(cacheControl);
    this.maxAgeMs = (parsedMaxAge ?? DEFAULT_CACHE_TTL_MS / 1000) * 1000;
    this.nextRefresh = now + this.maxAgeMs;
    this.etag = response.headers.get('etag') ?? undefined;

    let importedKeys = 0;
    for (const jwk of payload.keys) {
      const key = createVerifierFromJwk(jwk);
      if (!key || !jwk.kid) {
        continue;
      }
      this.keyCache.set(jwk.kid, {
        key,
        expiresAt: now + this.maxAgeMs
      });
      importedKeys += 1;
    }

    if (!this.keyCache.size && importedKeys === 0) {
      throw new WebhookVerificationError('No supported keys in JWKS response', 'jwks_empty');
    }
  }

  private bumpKeyExpiry(nextExpiry: number): void {
    for (const cached of this.keyCache.values()) {
      cached.expiresAt = nextExpiry;
    }
  }
}

function createVerifierFromJwk(jwk: MyOsJwk): VerifyingKey | null {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x || !jwk.kid) {
    return null;
  }

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({
      format: 'jwk',
      key: {
        kty: jwk.kty,
        crv: jwk.crv,
        x: jwk.x
      } as NodeJsonWebKey
    });
  } catch {
    return null;
  }

  const verifier = createVerifier(publicKey, 'ed25519');
  return {
    id: jwk.kid,
    algs: ['ed25519'],
    verify: verifier
  };
}

export function computeContentDigest(raw: Buffer): string {
  const digest = createHash('sha256').update(raw).digest('base64');
  return `sha-256=:${digest}:`;
}

function normalizeHeaders(headers: Record<string, string | undefined> | undefined): HeaderMap {
  const map: HeaderMap = new Map();
  if (!headers) {
    return map;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (!key || value === undefined || value === null) {
      continue;
    }
    map.set(key.toLowerCase(), value);
  }

  return map;
}

function buildTargetUrl(event: APIGatewayProxyEventV2, headers: HeaderMap): string {
  const scheme = headers.get('x-forwarded-proto') ?? 'https';
  const host =
    headers.get('x-forwarded-host') ??
    headers.get('host') ??
    event.requestContext.domainName ??
    event.requestContext.http?.sourceIp;
  if (!host) {
    throw new WebhookVerificationError('Missing host header', 'missing_host');
  }
  const path = event.rawPath ?? event.requestContext.http?.path ?? '/';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return `${scheme}://${host}${path}${query}`;
}

function parseMaxAge(headerValue: string | null): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const directives = headerValue.split(',');
  for (const directive of directives) {
    const [name, value] = directive.trim().split('=');
    if (name.toLowerCase() === 'max-age' && value) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function serializeError(error: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = { message: 'Unknown error' };
  if (error instanceof Error) {
    base.message = error.message;
    base.name = error.name;
    if (error.stack) {
      base.stack = error.stack;
    }
  }
  return base;
}

type MyOsJwk = NodeJsonWebKey & {
  kid?: string;
  use?: string;
};
