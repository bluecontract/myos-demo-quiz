import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context
} from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Blue } from '@blue-labs/language';
import { blueIds, repository as coreRepository } from '@blue-repository/core-dev';
import { repository as myosRepository } from '@blue-repository/myos-dev';
import {
  ChoiceSchema,
  DocumentSnapshotSchema,
  MyOsDocumentEpochAdvancedEventSchema,
  Orchestrator,
  QuestionAlreadyExistsError,
  RoundRequestedEventSchema,
  type MyOsDocumentPayload,
  type DocumentSnapshot,
  type AiClient,
  type MyOsClient,
  type QuestionRepo,
  type TimelineRegistry,
} from '@myos-quiz/core';
import { CappedAiClient, OpenAiClient, OpenAiMockClient } from '@myos-quiz/ai-openai';
import { HttpMyOsClient } from '@myos-quiz/myos-http';
import {
  DynamoQuestionRepo,
  DynamoRateLimiter,
  DynamoTimelineRegistry,
  DynamoWebhookDeliveryStore
} from '@myos-quiz/persistence-ddb';
import { loadConfig } from './env';
import { extractTimelineIds } from './timeline-extractor';
import { MyOsWebhookVerifier, WebhookVerificationError } from './webhook-verifier';
import packageJson from '../../../package.json';

const logger = new Logger({ serviceName: process.env.APP_NAME ?? 'myos-quiz' });
const metrics = new Metrics({ namespace: process.env.APP_NAME ?? 'myos-quiz' });
const tracer = new Tracer({ serviceName: process.env.APP_NAME ?? 'myos-quiz' });
const blue = new Blue({
  repositories: [coreRepository, myosRepository]
});

interface AppContext {
  orchestrator: Orchestrator;
  repo: DynamoQuestionRepo;
  ai: AiClient;
  myos: MyOsClient;
  stage: string;
  appName: string;
  timelineRegistry: TimelineRegistry;
  timelineGuardTtlHours: number;
  webhookVerifier: MyOsWebhookVerifier;
}

let appContextPromise: Promise<AppContext> | undefined;
let appContextFactory: () => Promise<AppContext> = bootstrap;

class InstrumentedAiClient implements AiClient {
  constructor(private readonly inner: AiClient) {}

  async generateQuestion(input: Parameters<AiClient['generateQuestion']>[0]) {
    try {
      const result = await this.inner.generateQuestion(input);
      metrics.addMetric('ai_call_success', MetricUnit.Count, 1);
      const usedMock = this.wasMockUsed();
      metrics.addMetric(
        usedMock ? 'openai_budget_fallback_mock' : 'openai_budget_token_granted',
        MetricUnit.Count,
        1
      );
      const reason = this.getMockReason();
      if (usedMock && reason === 'limit') {
        logger.warn('OpenAI budget cap reached; using mock question.');
      } else if (usedMock && reason === 'force') {
        logger.info('MOCK_OPENAI enabled; serving deterministic mock question.');
      }
      const requestId = this.getRequestId();
      if (requestId) {
        logger.appendKeys({ openaiRequestId: requestId });
        logger.debug('OpenAI question generated', { openaiRequestId: requestId });
      }
      return result;
    } catch (error) {
      metrics.addMetric('ai_call_error', MetricUnit.Count, 1);
      throw error;
    }
  }

  private getRequestId(): string | undefined {
    const candidate = this.inner as unknown as { getLastResponseId?: () => string | undefined };
    return candidate.getLastResponseId?.();
  }

  private wasMockUsed(): boolean {
    const candidate = this.inner as unknown as { wasLastCallMock?: () => boolean };
    return Boolean(candidate.wasLastCallMock?.());
  }

  private getMockReason(): 'force' | 'limit' | undefined {
    const candidate = this.inner as unknown as { getLastCallReason?: () => 'force' | 'limit' | undefined };
    return candidate.getLastCallReason?.();
  }
}

class InstrumentedMyOsClient implements MyOsClient {
  constructor(private readonly inner: MyOsClient) {}

  async startRound(sessionId: string, request: Parameters<MyOsClient['startRound']>[1]) {
    logger.debug('Preparing to call MyOS startRound', {
      sessionId,
      roundIndex: request.roundIndex,
      questionId: request.question?.questionId,
      category: request.question?.category,
      questionLevel: request.question?.level
    });
    await this.inner.startRound(sessionId, request);
    metrics.addMetric('round_started', MetricUnit.Count, 1);
  }

  async completeRound(sessionId: string, request: Parameters<MyOsClient['completeRound']>[1]) {
    logger.debug('Preparing to call MyOS completeRound', {
      sessionId,
      roundIndex: request.roundIndex,
      questionId: request.questionId,
      correctOption: request.correctOption,
      hasExplanation: Boolean(request.explanation)
    });
    await this.inner.completeRound(sessionId, request);
    metrics.addMetric('round_completed', MetricUnit.Count, 1);
  }
}

class InstrumentedQuestionRepo implements QuestionRepo {
  constructor(private readonly inner: QuestionRepo) {}

  async put(sessionId: string, roundIndex: number, data: Parameters<QuestionRepo['put']>[2]) {
    try {
      await this.inner.put(sessionId, roundIndex, data);
    } catch (error) {
      if (error instanceof QuestionAlreadyExistsError) {
        metrics.addMetric('ddb_conditional_failure', MetricUnit.Count, 1);
      }
      throw error;
    }
  }

  get(sessionId: string, roundIndex: number) {
    return this.inner.get(sessionId, roundIndex);
  }
}

async function bootstrap(): Promise<AppContext> {
  const config = await loadConfig();
  process.env.OPENAI_API_KEY = config.openAi.apiKey;
  logger.setPersistentLogAttributes({ stage: config.stage, app: config.appName });
  metrics.setDefaultDimensions({
    app: config.appName,
    stage: config.stage
  });

  const rateLimiter = new DynamoRateLimiter({ tableName: config.controlTableName });
  const timelineRegistry = new DynamoTimelineRegistry({
    tableName: config.controlTableName,
    defaultTtlHours: config.timelineGuardTtlHours
  });
  const deliveryStore = new DynamoWebhookDeliveryStore({
    tableName: config.controlTableName,
    replayTtlSeconds: config.webhook.replayTtlSeconds
  });

  const realAiClient = new OpenAiClient({ defaultModel: config.openAi.model });
  const mockAiClient = new OpenAiMockClient({ seed: config.openAiMockSeed });
  const cappedAi = new CappedAiClient(
    realAiClient,
    mockAiClient,
    rateLimiter,
    config.maxOpenAiCallsPerHour,
    config.mockOpenAi
  );
  if (config.mockOpenAi) {
    logger.warn('MOCK_OPENAI enabled; OpenAI API calls are disabled.');
  }
  const aiClient = new InstrumentedAiClient(cappedAi);
  const repo = new DynamoQuestionRepo({ tableName: config.tableName });
  const questionRepo = new InstrumentedQuestionRepo(repo);
  const myosClient = new InstrumentedMyOsClient(
    new HttpMyOsClient({ baseUrl: config.myos.baseUrl, apiKey: config.myos.apiKey })
  );

  const orchestrator = new Orchestrator(aiClient, myosClient, questionRepo, {
    debug: (message, context) =>
      context ? logger.debug(message, context) : logger.debug(message)
  });
  const webhookVerifier = new MyOsWebhookVerifier({
    jwksUrl: config.webhook.jwksUrl,
    toleranceSeconds: config.webhook.toleranceSeconds,
    replayTtlSeconds: config.webhook.replayTtlSeconds,
    deliveryStore,
    logger,
    metrics
  });
  return {
    orchestrator,
    repo,
    ai: aiClient,
    myos: myosClient,
    stage: config.stage,
    appName: config.appName,
    timelineRegistry,
    timelineGuardTtlHours: config.timelineGuardTtlHours,
    webhookVerifier
  };
}

async function getAppContext(): Promise<AppContext> {
  if (!appContextPromise) {
    appContextPromise = appContextFactory().catch(error => {
      appContextPromise = undefined;
      throw error;
    });
  }
  return appContextPromise;
}

const version = (packageJson as { version?: string }).version ?? '0.0.0';

async function baseHandler(
  event: APIGatewayProxyEventV2,
  context: Context
): Promise<APIGatewayProxyResultV2> {
  const correlationId = getCorrelationId(event);
  logger.appendKeys({ requestId: context.awsRequestId, correlationId });

  try {
    if (event.requestContext.http.method === 'GET') {
      if (matchesPath(event.rawPath, '/healthz')) {
        const app = await getAppContext();
        return ok({ ok: true, version, stage: app.stage });
      }

      if (matchesPath(event.rawPath, '/readyz')) {
        return await handleReadyz();
      }
    }

    if (event.requestContext.http.method === 'POST' && matchesPath(event.rawPath, '/webhooks/myos')) {
      const app = await getAppContext();
      const rawBodyBuffer = getRawBodyBuffer(event);
      const rawBody = rawBodyBuffer.toString('utf8');
      logger.debug('Received raw MyOS webhook body', {
        length: rawBodyBuffer.length,
        preview: rawBody.slice(0, 512)
      });
      let verification;
      try {
        verification = await app.webhookVerifier.verify(event, rawBodyBuffer);
      } catch (error) {
        const serialized = serializeError(error);
        logger.warn('Rejecting MyOS webhook due to verification error', { error: serialized });
        const status =
          error instanceof WebhookVerificationError ? error.statusCode : 401;
        const reason =
          error instanceof WebhookVerificationError ? error.reason : 'webhook_verification_failed';
        return {
          statusCode: status,
          body: JSON.stringify({ ok: false, reason }),
          headers: { 'content-type': 'application/json' }
        };
      }
      if (verification.duplicate) {
        return ok({ ok: true, replay: true });
      }
      let snapshot: DocumentSnapshot;
      try {
        snapshot = mapPayloadToSnapshot(rawBody);
      } catch (normalizationError) {
        logger.error('Ignoring MyOS webhook payload due to normalization error', {
          error: serializeError(normalizationError)
        });
        return ok({ ok: true });
      }
      logger.debug('Normalized MyOS snapshot', {
        sessionId: snapshot.sessionId,
        roundIndex: snapshot.roundIndex,
        phase: snapshot.phase,
        categories: snapshot.categories,
        emitted: snapshot.emitted
      });
      const timelineIds =
        Array.isArray(snapshot.timelineIds) && snapshot.timelineIds.length > 0
          ? snapshot.timelineIds
          : extractTimelineIds(snapshot);
      if (timelineIds.length < 3) {
        metrics.addMetric('timeline_structure_invalid', MetricUnit.Count, 1);
        logger.warn('Timeline guard: missing timeline bindings — skipping processing', {
          sessionId: snapshot.sessionId,
          timelineIds
        });
        return ok({ ok: true });
      }

      const okTimeline = await app.timelineRegistry.checkAndRegister(
        timelineIds,
        snapshot.sessionId,
        app.timelineGuardTtlHours
      );
      if (!okTimeline) {
        metrics.addMetric('timeline_conflict', MetricUnit.Count, 1);
        logger.warn('Timeline guard: conflict — skipping processing', {
          sessionId: snapshot.sessionId,
          timelineIds
        });
        return ok({ ok: true });
      }
      metrics.addMetric('timeline_bind_ok', MetricUnit.Count, 1);
      const intent = determinePlannedAction(snapshot);
      logger.info('Determined orchestrator action for MyOS webhook', intent);
      logger.info('Processing DOCUMENT_EPOCH_ADVANCED webhook', {
        sessionId: snapshot.sessionId,
        roundIndex: snapshot.roundIndex,
        phase: snapshot.phase,
        emittedCount: snapshot.emitted?.length ?? 0
      });
      await app.orchestrator.onDocumentUpdated(snapshot);
      await app.webhookVerifier.markDelivered(verification.deliveryId);
      return ok({ ok: true });
    }

    return notFound();
  } catch (error) {
    const serialized = serializeError(error);
    logger.error('Unhandled error in webhook handler', { error: serialized });
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Internal Server Error', error: serialized })
    };
  }
}

async function handleReadyz(): Promise<APIGatewayProxyResultV2> {
  try {
    const config = await loadConfig({ forceRefresh: true });
    process.env.OPENAI_API_KEY = config.openAi.apiKey;
    const repo = new DynamoQuestionRepo({ tableName: config.tableName });
    const canConnect = await repo.canConnect();
    if (!canConnect) {
      throw new Error('DynamoDB not reachable');
    }
    if (!config.openAi.apiKey) {
      throw new Error('Missing OPENAI_API_KEY');
    }
    return ok({ ok: true, version, stage: config.stage });
  } catch (error) {
    logger.error('Readiness check failed', { error: serializeError(error) });
    return {
      statusCode: 503,
      body: JSON.stringify({ ok: false, message: 'Not Ready' })
    };
  }
}

function mapPayloadToSnapshot(body: string | undefined): DocumentSnapshot {
  if (!body) {
    throw new Error('Request body is required');
  }

  const parsedJson = safeJsonParse(body);
  const event = MyOsDocumentEpochAdvancedEventSchema.parse(parsedJson);
  const payload: MyOsDocumentPayload = event.object;

  const documentState = normalizeDocument(payload.document);
  const emitted = normalizeEmitted(payload.emitted);
  const timelineIds = extractTimelineIds({ document: documentState });

  const roundIndex =
    coerceNumber(documentState.roundIndex) ??
    coerceNumber(documentState.currentRoundIndex) ??
    0;

  const snapshotCandidate: Record<string, unknown> = {
    sessionId: payload.sessionId,
    roundIndex,
    document: documentState
  };

  if (timelineIds.length > 0) {
    snapshotCandidate.timelineIds = timelineIds;
  }

  const roundsTotal = coerceNumber(documentState.roundsTotal);
  if (roundsTotal !== undefined) {
    snapshotCandidate.roundsTotal = roundsTotal;
  }

  const level = coerceNumber(documentState.level);
  if (level !== undefined) {
    snapshotCandidate.level = level;
  }

  const categories = extractCategories(documentState.categories);
  if (categories.length > 0) {
    snapshotCandidate.categories = categories;
  }

  const phase = extractPhase(documentState.phase);
  if (phase) {
    snapshotCandidate.phase = phase;
  }

  const currentQuestion = normalizeCurrentQuestion(documentState.currentQuestion);
  if (currentQuestion) {
    snapshotCandidate.currentQuestion = currentQuestion;
  }

  const answers = normalizeAnswers(documentState.answers);
  if (answers) {
    snapshotCandidate.answers = answers;
  }

  if (emitted) {
    snapshotCandidate.emitted = emitted;
  }

  const snapshotParsed = DocumentSnapshotSchema.safeParse(snapshotCandidate);
  if (!snapshotParsed.success) {
    logger.debug('review event type', { eventBlueIdInCore: blueIds['Event'], emittedTypes: Array.isArray(snapshotCandidate.emitted) ? snapshotCandidate.emitted.map(event => event?.type) : undefined})
    throw new Error(`Invalid document snapshot: ${snapshotParsed.error.toString()}`);
  }

  return snapshotParsed.data;
}

function matchesPath(rawPath: string | undefined, target: string): boolean {
  return (rawPath ?? '').toLowerCase() === target.toLowerCase();
}

function ok(body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' }
  };
}

function notFound(): APIGatewayProxyResultV2 {
  return {
    statusCode: 404,
    body: JSON.stringify({ message: 'Not Found' }),
    headers: { 'content-type': 'application/json' }
  };
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error('Malformed JSON body', { cause: error as Error });
  }
}

function getRawBodyBuffer(event: APIGatewayProxyEventV2): Buffer {
  const body = event.body ?? '';
  if (event.isBase64Encoded) {
    return Buffer.from(body, 'base64');
  }
  return Buffer.from(body, 'utf8');
}

function getCorrelationId(event: APIGatewayProxyEventV2): string {
  return (
    event.headers?.['x-correlation-id'] ??
    event.headers?.['x-request-id'] ??
    event.requestContext.requestId ??
    `corr-${Date.now()}`
  );
}

function serializeError(error: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = { message: 'Unknown error' };
  if (error instanceof Error) {
    base.message = error.message;
    base.name = error.name;
    base.stack = error.stack;
    if ('cause' in error && error.cause) {
      base.cause = error.cause;
    }
  }
  return base;
}

interface PlannedActionLog {
  action: 'start_round' | 'complete_round' | 'noop';
  reason: string;
  sessionId: string;
  roundIndex: number;
  [key: string]: unknown;
}

function determinePlannedAction(snapshot: DocumentSnapshot): PlannedActionLog {
  const roundRequested = extractRoundRequestedEvent(snapshot);
  if (roundRequested) {
    const requestedRoundIndex = roundRequested.nextRoundIndex ?? snapshot.roundIndex;
    return {
      action: 'start_round',
      reason: 'round_requested_event',
      sessionId: snapshot.sessionId,
      roundIndex: snapshot.roundIndex,
      requestedRoundIndex,
      categories: snapshot.categories ?? [],
      questionLevel: snapshot.level ?? 0
    };
  }

  const answeredPlayers = extractAnsweredPlayers(snapshot);
  if (answeredPlayers.shouldComplete) {
    return {
      action: 'complete_round',
      reason: 'all_players_answered',
      sessionId: snapshot.sessionId,
      roundIndex: snapshot.roundIndex,
      playersAnswered: Array.from(answeredPlayers.players),
      answersCollected: answeredPlayers.players.size
    };
  }

  return {
    action: 'noop',
    reason: answeredPlayers.players.size > 0 ? 'waiting_for_remaining_answers' : 'no_matching_triggers',
    sessionId: snapshot.sessionId,
    roundIndex: snapshot.roundIndex,
    phase: snapshot.phase
  };
}

function extractRoundRequestedEvent(snapshot: DocumentSnapshot) {
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

function extractAnsweredPlayers(snapshot: DocumentSnapshot): {
  players: Set<string>;
  shouldComplete: boolean;
} {
  const players = new Set<string>();
  if (snapshot.phase !== 'IN_ROUND') {
    return { players, shouldComplete: false };
  }

  const answers = snapshot.answers;
  if (!answers || typeof answers !== 'object') {
    return { players, shouldComplete: false };
  }

  for (const [player, value] of Object.entries(answers as Record<string, unknown>)) {
    if (!value) {
      continue;
    }

    let candidate: unknown = value;
    if (typeof value === 'object' && 'choice' in (value as Record<string, unknown>)) {
      candidate = (value as Record<string, unknown>).choice;
    }

    const parsed = ChoiceSchema.safeParse(candidate);
    if (parsed.success) {
      players.add(player);
    }
  }

  return {
    players,
    shouldComplete: players.size >= 2
  };
}

function normalizeDocument(document: unknown): Record<string, unknown> {
  if (document === undefined || document === null) {
    return {};
  }

  try {
    const node = blue.restoreInlineTypes(blue.jsonValueToNode(document));
    const json = blue.nodeToJson(node, 'original');
    if (!isRecord(json)) {
      return {};
    }
    // we need to destructure the json object to get the state
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {name, description, blueId, created, updated, ...state} = json as Record<string, unknown>;

    return toPlain(state) as Record<string, unknown>;
  } catch (error) {
    throw new Error('Unable to parse MyOS document payload', { cause: error as Error });
  }
}

function normalizeEmitted(emitted: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(emitted) || emitted.length === 0) {
    return undefined;
  }

  const normalized: Array<Record<string, unknown>> = [];

  for (const rawEvent of emitted) {
    try {
      const node = blue.restoreInlineTypes(blue.jsonValueToNode(rawEvent));
      const json = blue.nodeToJson(node, 'original');
      const plain = toPlain(json);
      if (isRecord(plain)) {
        normalized.push(normalizeEventShape(plain));
        continue;
      }
    } catch {
      // Fallback to raw event below
    }

    if (isRecord(rawEvent)) {
      const plain = toPlain(rawEvent);
      if (isRecord(plain)) {
        normalized.push(normalizeEventShape(plain));
      }
    }
  }

  return normalized.length > 0 ? normalized : undefined;
}

function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => toPlain(item));
  }

  if (isRecord(value)) {
    if ('value' in value) {
      const keys = Object.keys(value);
      if (keys.every(key => key === 'value' || key === 'type' || key === 'description')) {
        return toPlain(value.value);
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = toPlain(entry);
    }
    return result;
  }

  return value;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (isRecord(value) && 'value' in value) {
    return coerceNumber(value.value);
  }
  return undefined;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  if (isRecord(value)) {
    if (typeof value.value === 'string') {
      return value.value;
    }
    if (typeof value.type === 'string' && Object.keys(value).length === 1) {
      return value.type;
    }
  }
  return undefined;
}

function extractCategories(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(coerceString).filter((category): category is string => Boolean(category));
  }

  if (isRecord(value) && Array.isArray(value.items)) {
    return value.items
      .map(item => (isRecord(item) ? coerceString(item.value ?? item.type ?? item) : coerceString(item)))
      .filter((category): category is string => Boolean(category));
  }

  return [];
}

function extractPhase(value: unknown): 'IN_ROUND' | 'BETWEEN_ROUNDS' | 'GAME_COMPLETED' | undefined {
  const phase = coerceString(value);
  if (phase === 'IN_ROUND' || phase === 'BETWEEN_ROUNDS' || phase === 'GAME_COMPLETED') {
    return phase;
  }
  return undefined;
}

function normalizeCurrentQuestion(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return toPlain(value) as Record<string, unknown>;
}

function normalizeAnswers(
  value: unknown
): Record<string, Record<string, unknown> & { choice?: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: Record<string, Record<string, unknown> & { choice?: string }> = {};

  for (const [player, rawAnswer] of Object.entries(value)) {
    if (rawAnswer === null || rawAnswer === undefined) {
      continue;
    }

    if (typeof rawAnswer === 'string') {
      const choice = coerceChoice(rawAnswer);
      if (choice) {
        normalized[player] = { choice };
      }
      continue;
    }

    if (isRecord(rawAnswer)) {
      const plainAnswer = toPlain(rawAnswer) as Record<string, unknown>;
      const choice = coerceChoice(plainAnswer.choice);
      if (choice) {
        normalized[player] = { ...plainAnswer, choice };
      } else {
        normalized[player] = { ...plainAnswer };
      }
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : {};
}

function coerceChoice(value: unknown): string | undefined {
  const candidate = coerceString(value);
  if (!candidate) {
    return undefined;
  }
  const parsed = ChoiceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEventShape(event: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...event };
  const refinedKind = coerceString(normalized.kind);
  if (refinedKind) {
    normalized.kind = refinedKind;
  }
  const refinedType = coerceString(normalized.type);
  if (refinedType) {
    normalized.type = refinedType;
  }
  if (typeof normalized.type === 'string') {
    if (normalized.type === 'Event' && refinedKind) {
      normalized.type = refinedKind;
    }
  } else if (refinedKind) {
    normalized.type = refinedKind;
  }
  return normalized;
}

let coldStart = true;

const instrumentedHandler = async (
  event: APIGatewayProxyEventV2,
  context: Context
): Promise<APIGatewayProxyResultV2> => {
  logger.addContext(context);
  logger.logEventIfEnabled(event);
  const handlerName = process.env._HANDLER ?? 'handler';

  if (coldStart) {
    metrics.captureColdStartMetric(context.functionName);
  }

  try {
    const result = await tracer.provider.captureAsyncFunc(`## ${handlerName}`, async () => {
      tracer.annotateColdStart();
      tracer.addServiceNameAnnotation();
      return baseHandler(event, context);
    });
    return result as APIGatewayProxyResultV2;
  } finally {
    metrics.publishStoredMetrics();
    logger.resetKeys();
    coldStart = false;
  }
};

export const handler = instrumentedHandler;

export function __setAppContextFactory(factory: () => Promise<AppContext> | AppContext): void {
  appContextPromise = undefined;
  appContextFactory = async () => Promise.resolve(factory());
}
