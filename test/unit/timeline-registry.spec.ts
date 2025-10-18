import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoTimelineRegistry } from '@myos-quiz/persistence-ddb';

type Behaviour =
  | { command: 'put'; error?: Error }
  | { command: 'get'; response: unknown }
  | { command: 'update'; response: unknown };

const makeClient = (behaviours: Behaviour[]): DynamoDBDocumentClient =>
  ({
    send: vi.fn(async (command: unknown) => {
      const next = behaviours.shift();
      if (!next) {
        throw new Error('Unexpected command with no configured behaviour');
      }

      if (command instanceof PutCommand) {
        if (next.command !== 'put') {
          throw new Error(`Expected ${next.command} but received put`);
        }
        if (next.error) {
          throw next.error;
        }
        return {};
      }

      if (command instanceof GetCommand) {
        if (next.command !== 'get') {
          throw new Error(`Expected ${next.command} but received get`);
        }
        return next.response;
      }

      if (command instanceof UpdateCommand) {
        if (next.command !== 'update') {
          throw new Error(`Expected ${next.command} but received update`);
        }
        return next.response;
      }

      throw new Error('Unsupported command');
    })
  }) as unknown as DynamoDBDocumentClient;

describe('DynamoTimelineRegistry', () => {
  it('allows first registrant and rejects conflicting session', async () => {
    const behaviours: Behaviour[] = [
      { command: 'put' },
      {
        command: 'put',
        error: new ConditionalCheckFailedException({
          $metadata: {},
          message: 'exists'
        })
      },
      {
        command: 'get',
        response: {
          Item: {
            pk: 'TIMELINE#tl-1',
            sk: 'SESSION',
            sessionId: 'sess-1'
          }
        }
      },
      { command: 'update', response: {} },
      {
        command: 'put',
        error: new ConditionalCheckFailedException({
          $metadata: {},
          message: 'exists'
        })
      },
      {
        command: 'get',
        response: {
          Item: {
            pk: 'TIMELINE#tl-1',
            sk: 'SESSION',
            sessionId: 'sess-1'
          }
        }
      }
    ];

    const queue = behaviours.slice();
    const registry = new DynamoTimelineRegistry({
      tableName: 'MyosQuizControl',
      client: makeClient(queue)
    });

    await expect(registry.checkAndRegister(['tl-1'], 'sess-1')).resolves.toBe(true);
    await expect(registry.checkAndRegister(['tl-1'], 'sess-1')).resolves.toBe(true);
    await expect(registry.checkAndRegister(['tl-1'], 'sess-2')).resolves.toBe(false);
    expect(queue.length).toBe(0);
  });
});
