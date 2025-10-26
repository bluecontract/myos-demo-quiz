import {
  ConditionalCheckFailedException,
  DynamoDBClient
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

export interface DynamoWebhookDeliveryStoreOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  replayTtlSeconds?: number;
}

const DEFAULT_REPLAY_TTL_SECONDS = 24 * 60 * 60; // 24h

export class DynamoWebhookDeliveryStore {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;
  private readonly replayTtlSeconds: number;

  constructor(options: DynamoWebhookDeliveryStoreOptions) {
    if (!options.tableName) {
      throw new Error('CONTROL_TABLE_NAME must be provided for DynamoWebhookDeliveryStore');
    }
    this.tableName = options.tableName;
    this.client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
    this.replayTtlSeconds =
      typeof options.replayTtlSeconds === 'number' && options.replayTtlSeconds > 0
        ? options.replayTtlSeconds
        : DEFAULT_REPLAY_TTL_SECONDS;
  }

  async hasSeen(deliveryId: string): Promise<boolean> {
    if (!deliveryId) {
      throw new Error('deliveryId is required');
    }

    const key = {
      pk: 'WEBHOOK#DELIVERY',
      sk: deliveryId
    };

    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ConsistentRead: true
      })
    );

    return Boolean(result.Item);
  }

  async markHandled(deliveryId: string, ttlSeconds?: number, now: Date = new Date()): Promise<boolean> {
    if (!deliveryId) {
      throw new Error('deliveryId is required');
    }

    const seconds = Math.max(1, ttlSeconds ?? this.replayTtlSeconds);
    const expiresAt = Math.floor(now.getTime() / 1000) + seconds;
    const key = {
      pk: 'WEBHOOK#DELIVERY',
      sk: deliveryId
    };

    const command = new PutCommand({
      TableName: this.tableName,
      Item: {
        ...key,
        firstSeenAt: Math.floor(now.getTime() / 1000),
        expiresAt
      },
      ConditionExpression: 'attribute_not_exists(pk)'
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
