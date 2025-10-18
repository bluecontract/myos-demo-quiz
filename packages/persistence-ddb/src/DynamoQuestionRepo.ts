import {
  DynamoDBClient,
  ConditionalCheckFailedException,
  DescribeTableCommand
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand
} from '@aws-sdk/lib-dynamodb';
import type { PutCommandInput } from '@aws-sdk/lib-dynamodb';
import type { QuestionRepo, StoredQuestion } from '@myos-quiz/core';
import { QuestionAlreadyExistsError } from '@myos-quiz/core';

export interface DynamoQuestionRepoOptions {
  tableName: string;
  ttlHours?: number;
  client?: DynamoDBDocumentClient;
}

export class DynamoQuestionRepo implements QuestionRepo {
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;
  private readonly ttlHours: number;

  constructor(options: DynamoQuestionRepoOptions) {
    if (!options.tableName) {
      throw new Error('TABLE_NAME must be provided');
    }

    this.tableName = options.tableName;
    this.ttlHours = options.ttlHours ?? 24;
    const underlying =
      options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));

    this.client = underlying;
  }

  async put(sessionId: string, roundIndex: number, data: StoredQuestion): Promise<void> {
    const expiresAt = this.computeTtl();

    const input: PutCommandInput = {
      TableName: this.tableName,
      Item: {
        sessionId,
        roundIndex,
        questionId: data.questionId,
        correctOption: data.correctOption,
        explanation: data.explanation,
        expiresAt
      },
      ConditionExpression:
        'attribute_not_exists(sessionId) AND attribute_not_exists(roundIndex)'
    };

    try {
      await this.client.send(new PutCommand(input));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new QuestionAlreadyExistsError(sessionId, roundIndex);
      }
      throw error;
    }
  }

  async get(sessionId: string, roundIndex: number): Promise<StoredQuestion | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { sessionId, roundIndex }
      })
    );

    if (!result.Item) {
      return null;
    }

    return {
      questionId: result.Item.questionId,
      correctOption: result.Item.correctOption,
      explanation: result.Item.explanation
    } as StoredQuestion;
  }

  async canConnect(): Promise<boolean> {
    try {
      await this.client.send(new DescribeTableCommand({ TableName: this.tableName }));
      return true;
    } catch (error) {
      return false;
    }
  }

  private computeTtl(): number {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ttlSeconds = Math.floor(this.ttlHours * 60 * 60);
    return nowSeconds + ttlSeconds;
  }
}
