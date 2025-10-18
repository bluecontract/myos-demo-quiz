import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack, aws_logs as logs, CfnOutput } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { HttpApi, CorsHttpMethod, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

interface MyosQuizStackProps extends StackProps {
  stage: string;
}

export class MyosQuizStack extends Stack {
  constructor(scope: Construct, id: string, props: MyosQuizStackProps) {
    super(scope, id, props);

    const appName = 'myos-quiz';
    const stage = props.stage ?? 'dev';
    const secretsPrefix = `/myos-quiz/${stage}`;

    const questionsTableName = `${appName}-${stage}-questions`;
    const controlTableName = `${appName}-${stage}-control`;

    const table = new Table(this, 'QuestionsTable', {
      tableName: questionsTableName,
      partitionKey: { name: 'sessionId', type: AttributeType.STRING },
      sortKey: { name: 'roundIndex', type: AttributeType.NUMBER },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });

    const controlTable = new Table(this, 'ControlTable', {
      tableName: controlTableName,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt'
    });

    const dlq = new Queue(this, 'WebhookDlq', {
      queueName: `${appName}-${stage}-webhook-dlq`,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY
    });

    const openAiSecret = new Secret(this, 'OpenAiApiKeySecret', {
      secretName: `${secretsPrefix}/OPENAI_API_KEY`,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const myosSecret = new Secret(this, 'MyOsApiKeySecret', {
      secretName: `${secretsPrefix}/MYOS_API_KEY`,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const myosBaseUrl = this.node.tryGetContext('myosBaseUrl') ?? 'https://api.myos.blue';
    const openAiModel = this.node.tryGetContext('openAiModel') ?? 'gpt-4o-mini';

    const webhookFunction = new NodejsFunction(this, 'MyOSWebhookHandler', {
      functionName: `${appName}-${stage}-webhook`,
      entry: path.join(__dirname, '..', '..', 'packages', 'webhook', 'src', 'handler.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
      bundling: {
        minify: true,
        sourcesContent: false,
        externalModules: ['aws-sdk'],
        target: 'node20'
      },
      environment: {
        APP_NAME: appName,
        STAGE: stage,
        TABLE_NAME: table.tableName,
        CONTROL_TABLE_NAME: controlTable.tableName,
        OPENAI_MODEL: openAiModel,
        MYOS_BASE_URL: myosBaseUrl,
        SECRETS_PREFIX: secretsPrefix,
        LOG_LEVEL: 'INFO',
        POWERTOOLS_SERVICE_NAME: appName,
        POWERTOOLS_METRICS_NAMESPACE: appName,
        POWERTOOLS_LOGGER_LOG_EVENT: 'true',
        MOCK_OPENAI: 'false',
        MAX_OPENAI_CALLS_PER_HOUR: '100',
        TIMELINE_GUARD_TTL_HOURS: '48'
      },
      reservedConcurrentExecutions: undefined,
      tracing: Tracing.ACTIVE,
      deadLetterQueue: dlq,
      logRetention: logs.RetentionDays.ONE_WEEK
    });

    table.grantReadWriteData(webhookFunction);
    controlTable.grantReadWriteData(webhookFunction);
    openAiSecret.grantRead(webhookFunction);
    myosSecret.grantRead(webhookFunction);

    const api = new HttpApi(this, 'WebhookApi', {
      apiName: `${appName}-${stage}`,
      corsPreflight: {
        allowHeaders: ['content-type'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        allowOrigins: ['*']
      }
    });

    const integration = new HttpLambdaIntegration('WebhookIntegration', webhookFunction);

    api.addRoutes({
      path: '/webhooks/myos',
      methods: [HttpMethod.POST],
      integration
    });

    api.addRoutes({
      path: '/healthz',
      methods: [HttpMethod.GET],
      integration
    });

    api.addRoutes({
      path: '/readyz',
      methods: [HttpMethod.GET],
      integration
    });

    new CfnOutput(this, 'HttpApiUrl', {
      value: api.apiEndpoint
    });

    new CfnOutput(this, 'SecretsPrefix', {
      value: secretsPrefix
    });

    new CfnOutput(this, 'QuestionsTableName', {
      value: table.tableName
    });

    new CfnOutput(this, 'ControlTableName', {
      value: controlTable.tableName
    });
  }
}
