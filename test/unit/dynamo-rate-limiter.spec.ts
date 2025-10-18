import { describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoRateLimiter } from '@myos-quiz/persistence-ddb';

describe('DynamoRateLimiter', () => {
  it('consumes tokens until the hourly limit is reached', async () => {
    const send = vi
      .fn<Parameters<DynamoDBDocumentClient['send']>, Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: 'limit reached'
        })
      );

    const client = { send } as unknown as DynamoDBDocumentClient;
    const limiter = new DynamoRateLimiter({
      tableName: 'MyosQuizControl',
      client
    });

    const now = new Date(Date.UTC(2024, 0, 1, 0, 30, 0));

    await expect(
      limiter.tryConsume({ budget: 'openai', windowSeconds: 3600, limit: 2, now })
    ).resolves.toBe(true);

    await expect(
      limiter.tryConsume({ budget: 'openai', windowSeconds: 3600, limit: 2, now })
    ).resolves.toBe(true);

    await expect(
      limiter.tryConsume({ budget: 'openai', windowSeconds: 3600, limit: 2, now })
    ).resolves.toBe(false);

    expect(send).toHaveBeenCalledTimes(3);
    const firstCommand = send.mock.calls[0][0];
    expect(firstCommand).toBeInstanceOf(UpdateCommand);
    const input = (firstCommand as UpdateCommand).input;
    expect(input?.Key).toEqual({
      pk: 'BUDGET#OPENAI',
      sk: 'HOUR#2024010100'
    });
    const expectedExpiry =
      Math.floor(Date.UTC(2024, 0, 1, 0, 0, 0) / 1000) + 3600 + 3600;
    expect(input?.ExpressionAttributeValues?.[':exp']).toBe(expectedExpiry);
  });
});
