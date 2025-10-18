import {
  ConditionalCheckFailedException,
  DynamoDBClient
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import type { TimelineRegistry } from '@myos-quiz/core';

export interface DynamoTimelineRegistryOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  defaultTtlHours?: number;
}

export class DynamoTimelineRegistry implements TimelineRegistry {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;
  private readonly defaultTtlHours: number;

  constructor(options: DynamoTimelineRegistryOptions) {
    if (!options.tableName) {
      throw new Error('CONTROL_TABLE_NAME must be provided for DynamoTimelineRegistry');
    }
    this.tableName = options.tableName;
    this.client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
    this.defaultTtlHours =
      options.defaultTtlHours ?? parseInt(process.env.TIMELINE_GUARD_TTL_HOURS ?? '48', 10);
  }

  async checkAndRegister(
    timelineIds: string[],
    sessionId: string,
    ttlHours?: number
  ): Promise<boolean> {
    if (!timelineIds.length || !sessionId) {
      return true;
    }

    const uniqueIds = Array.from(new Set(timelineIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
      return true;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttl = ttlHours ?? this.defaultTtlHours;
    const ttlSeconds = Math.max(1, ttl) * 3600;
    const expiresAt = nowSeconds + ttlSeconds;

    for (const timelineId of uniqueIds) {
      const key = {
        pk: `TIMELINE#${timelineId}`,
        sk: 'SESSION'
      };

      let bound = false;
      let attempts = 0;

      while (!bound && attempts < 3) {
        attempts += 1;
        try {
          await this.client.send(
            new PutCommand({
              TableName: this.tableName,
              Item: {
                ...key,
                sessionId,
                firstSeenAt: nowSeconds,
                lastSeenAt: nowSeconds,
                expiresAt
              },
              ConditionExpression: 'attribute_not_exists(pk)'
            })
          );
          bound = true;
          continue;
        } catch (error) {
          if (!(error instanceof ConditionalCheckFailedException)) {
            throw error;
          }
        }

        const existing = await this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: key,
            ConsistentRead: true
          })
        );

        const item = existing.Item;
        if (!item) {
          // Item vanished between Put and Get (TTL or race). Retry Put.
          continue;
        }

        if (item.sessionId !== sessionId) {
          return false;
        }

        await this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: key,
            UpdateExpression: 'SET #lastSeenAt = :now, #exp = :exp',
            ConditionExpression: '#sessionId = :sessionId',
            ExpressionAttributeNames: {
              '#lastSeenAt': 'lastSeenAt',
              '#exp': 'expiresAt',
              '#sessionId': 'sessionId'
            },
            ExpressionAttributeValues: {
              ':now': nowSeconds,
              ':exp': expiresAt,
              ':sessionId': sessionId
            }
          })
        );
        bound = true;
      }
    }

    return true;
  }
}
