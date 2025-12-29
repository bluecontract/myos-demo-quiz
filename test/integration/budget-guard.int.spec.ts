import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { handler, __setAppContextFactory } from '@myos-quiz/webhook';
import {
  Orchestrator,
  type MyOsClient,
  type StartRoundRequest,
  type TimelineRegistry
} from '@myos-quiz/core';
import { CappedAiClient, OpenAiClient, OpenAiMockClient } from '@myos-quiz/ai-openai';
import { DynamoQuestionRepo, DynamoRateLimiter } from '@myos-quiz/persistence-ddb';
import { loadMyosFixtureResolved } from '../fixtures/myos';

const QUESTIONS_TABLE = 'MyosQuizQuestions';
const CONTROL_TABLE = 'MyosQuizControl';
const fixture = loadMyosFixtureResolved('document-updated-event_round-requested.json');

const questionItems = new Map<string, Record<string, unknown>>();
const budgetWindows = new Map<string, { count: number; limit: number; expiresAt: number }>();

const createQuestionsClient = (): DynamoDBDocumentClient =>
  ({
    send: async (command: unknown) => {
      if (command instanceof PutCommand) {
        const key = `${command.input.Item.sessionId}|${command.input.Item.roundIndex}`;
        if (command.input.ConditionExpression && questionItems.has(key)) {
          throw new ConditionalCheckFailedException({ $metadata: {} });
        }
        questionItems.set(key, command.input.Item as Record<string, unknown>);
        return {};
      }
      if (command instanceof GetCommand) {
        const key = `${command.input.Key.sessionId}|${command.input.Key.roundIndex}`;
        const item = questionItems.get(key);
        return item ? { Item: item } : {};
      }
      throw new Error('Unsupported command for questions table');
    }
  }) as unknown as DynamoDBDocumentClient;

const createControlClient = (): DynamoDBDocumentClient =>
  ({
    send: async (command: unknown) => {
      if (!(command instanceof UpdateCommand)) {
        throw new Error('Unsupported command for control table');
      }
      const key = `${command.input.Key.pk}|${command.input.Key.sk}`;
      const current = budgetWindows.get(key) ?? { count: 0, limit: 0, expiresAt: 0 };
      const limit = Number(command.input.ExpressionAttributeValues?.[':limit'] ?? 0);
      if (current.count >= limit) {
        throw new ConditionalCheckFailedException({ $metadata: {}, message: 'limit reached' });
      }
      const nextCount = current.count + 1;
      budgetWindows.set(key, {
        count: nextCount,
        limit,
        expiresAt: Number(command.input.ExpressionAttributeValues?.[':exp'] ?? 0)
      });
      return {};
    }
  }) as unknown as DynamoDBDocumentClient;

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

function buildAppContext(fakeMyOs: MyOsClient) {
  const repo = new DynamoQuestionRepo({
    tableName: QUESTIONS_TABLE,
    client: createQuestionsClient()
  });
  const limiter = new DynamoRateLimiter({
    tableName: CONTROL_TABLE,
    client: createControlClient()
  });
  const realAi = new OpenAiClient({ defaultModel: process.env.OPENAI_MODEL });
  const mockAi = new OpenAiMockClient({ seed: process.env.OPENAI_MOCK_SEED ?? 'test-seed' });
  const cappedAi = new CappedAiClient(realAi, mockAi, limiter, 1, false);
  const orchestrator = new Orchestrator(cappedAi, fakeMyOs, repo);
  const timelineRegistry: TimelineRegistry = { checkAndRegister: async () => true };
  const webhookVerifier = createWebhookVerifierMock();
  return {
    orchestrator,
    repo,
    ai: cappedAi,
    myos: fakeMyOs,
    stage: 'test',
    appName: 'myos-quiz',
    timelineRegistry,
    timelineGuardTtlHours: 48,
    webhookVerifier
  };
}

describe('Budget guard integration', () => {
  beforeEach(() => {
    questionItems.clear();
    budgetWindows.clear();
    process.env.TABLE_NAME = QUESTIONS_TABLE;
    process.env.CONTROL_TABLE_NAME = CONTROL_TABLE;
    process.env.APP_NAME = 'myos-quiz';
    process.env.STAGE = 'test';
    process.env.MYOS_BASE_URL = 'https://myos.local';
    process.env.OPENAI_MODEL = 'gpt-test';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MAX_OPENAI_CALLS_PER_HOUR = '1';
    process.env.MOCK_OPENAI = 'false';
    process.env.OPENAI_MOCK_SEED = 'budget';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_SESSION_TOKEN = 'test';
  });

  afterEach(() => {
    nock.cleanAll();
    __setAppContextFactory(() => {
      throw new Error('App context factory should be set in each test');
    });
    vi.useRealTimers();
  });

  it('falls back to the mock AI after exceeding the hourly OpenAI budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2024, 0, 1, 0, 0, 0)));

    const startRoundCalls: Array<{ sessionId: string; payload: StartRoundRequest }> = [];
    const fakeMyOs: MyOsClient = {
      startRound: async (sessionId: string, payload: StartRoundRequest) => {
        startRoundCalls.push({ sessionId, payload });
      },
      completeRound: async () => undefined
    };

    __setAppContextFactory(() => buildAppContext(fakeMyOs));

    const expected = {
      questionId: 'q-real',
      category: 'Science',
      prompt: 'What is H2O?',
      options: { A: 'Water', B: 'Oxygen', C: 'Hydrogen', D: 'Helium' },
      correctOption: 'A',
      explanation: 'Because chemistry.'
    };

    nock('https://api.openai.com')
      .post('/v1/responses')
      .reply(200, {
        id: 'resp_1',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(expected)
              }
            ]
          }
        ]
      });

    const firstEvent: APIGatewayProxyEventV2 = {
      ...baseEvent,
      body: fixture
    };

    const secondPayload = JSON.parse(fixture);
    secondPayload.object.sessionId = 'budget-session-2';
    const secondEvent: APIGatewayProxyEventV2 = {
      ...baseEvent,
      body: JSON.stringify(secondPayload)
    };

    const firstResponse = await handler(firstEvent, baseContext);
    expect(firstResponse.statusCode).toBe(200);
    expect(startRoundCalls).toHaveLength(1);
    expect(startRoundCalls[0].payload.question.prompt).toBe('What is H2O?');

    const secondResponse = await handler(secondEvent, baseContext);
    expect(secondResponse.statusCode).toBe(200);
    expect(startRoundCalls).toHaveLength(2);
    expect(startRoundCalls[1].payload.question.prompt).toContain('[MOCK]');
    expect(startRoundCalls[1].payload.question.options).toHaveProperty('A', 'Mock A');

    expect(nock.isDone()).toBe(true);
  });
});
