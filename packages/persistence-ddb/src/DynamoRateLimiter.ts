import {
  ConditionalCheckFailedException,
  DynamoDBClient
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { RateLimiter } from '@myos-quiz/core';

export interface DynamoRateLimiterOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoRateLimiter implements RateLimiter {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(options: DynamoRateLimiterOptions) {
    if (!options.tableName) {
      throw new Error('CONTROL_TABLE_NAME must be provided for DynamoRateLimiter');
    }
    this.tableName = options.tableName;
    this.client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async tryConsume(opts: {
    budget: 'openai';
    windowSeconds: number;
    limit: number;
    now?: Date;
  }): Promise<boolean> {
    const now = opts.now ?? new Date();
    const windowKey = formatUtcHour(now);
    const { windowSeconds, limit } = opts;
    const expiresAt = computeExpiry(now, windowSeconds);
    const key = {
      pk: `BUDGET#${opts.budget.toUpperCase()}`,
      sk: `HOUR#${windowKey}`
    };

    const command = new UpdateCommand({
      TableName: this.tableName,
      Key: key,
      UpdateExpression:
        'SET #count = if_not_exists(#count, :zero) + :one, #limit = :limit, #exp = :exp',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: {
        '#count': 'count',
        '#limit': 'limit',
        '#exp': 'expiresAt'
      },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':limit': limit,
        ':exp': expiresAt
      }
    });

    try {
      await this.client.send(command);
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
}

function formatUtcHour(date: Date): string {
  const year = date.getUTCFullYear();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hour = date.getUTCHours().toString().padStart(2, '0');
  return `${year}${month}${day}${hour}`;
}

function computeExpiry(now: Date, windowSeconds: number): number {
  const windowStartMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours()
  );
  const windowEndSeconds = Math.floor(windowStartMs / 1000) + windowSeconds;
  const expirySeconds = windowEndSeconds + 3600; // keep historical window around for an extra hour
  return expirySeconds;
}
