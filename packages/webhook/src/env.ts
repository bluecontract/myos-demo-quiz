import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export interface AppConfig {
  appName: string;
  stage: string;
  tableName: string;
  controlTableName: string;
  secretsPrefix: string;
  logLevel: string;
  mockOpenAi: boolean;
  maxOpenAiCallsPerHour?: number;
  openAiMockSeed: string;
  timelineGuardTtlHours: number;
  openAi: {
    apiKey: string;
    model: string;
  };
  myos: {
    baseUrl: string;
    apiKey: string;
  };
}

const secretsClient = new SecretsManagerClient({});
const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedConfig: { value: AppConfig; expiresAt: number } | undefined;

export async function loadConfig(options: { forceRefresh?: boolean } = {}): Promise<AppConfig> {
  const now = Date.now();
  if (!options.forceRefresh && cachedConfig && cachedConfig.expiresAt > now) {
    return cachedConfig.value;
  }

  const appName = process.env.APP_NAME ?? 'myos-quiz';
  const stage = process.env.STAGE ?? 'dev';
  const tableName = requiredEnv('TABLE_NAME');
  const controlTableName = requiredEnv('CONTROL_TABLE_NAME');
  const secretsPrefix = process.env.SECRETS_PREFIX ?? `/myos-quiz/${stage}`;
  const logLevel = process.env.LOG_LEVEL ?? 'INFO';
  const openAiModel = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const myosBaseUrl = requiredEnv('MYOS_BASE_URL');

  const mockOpenAi = (process.env.MOCK_OPENAI ?? 'false').toLowerCase() === 'true';
  const openAiKey = mockOpenAi
    ? process.env.OPENAI_API_KEY ?? 'mock-openai-key'
    : await getSecret(`${secretsPrefix}/OPENAI_API_KEY`);
  const myosKey = await getSecret(`${secretsPrefix}/MYOS_API_KEY`);
  const maxOpenAi = parseOptionalInt(process.env.MAX_OPENAI_CALLS_PER_HOUR);
  const timelineGuardTtlHours =
    parseOptionalInt(process.env.TIMELINE_GUARD_TTL_HOURS) ?? 48;
  const openAiMockSeed = process.env.OPENAI_MOCK_SEED ?? 'myos-quiz';

  const config: AppConfig = {
    appName,
    stage,
    tableName,
    controlTableName,
    secretsPrefix,
    logLevel,
    mockOpenAi,
    maxOpenAiCallsPerHour: maxOpenAi,
    openAiMockSeed,
    timelineGuardTtlHours,
    openAi: {
      apiKey: openAiKey,
      model: openAiModel
    },
    myos: {
      baseUrl: myosBaseUrl,
      apiKey: myosKey
    }
  };

  cachedConfig = { value: config, expiresAt: Date.now() + CACHE_TTL_MS };
  return config;
}

async function getSecret(secretId: string): Promise<string> {
  const command = new GetSecretValueCommand({ SecretId: secretId });
  const response = await secretsClient.send(command);
  const secret = response.SecretString ?? Buffer.from(response.SecretBinary ?? '').toString('utf8');
  if (!secret) {
    throw new Error(`Secret ${secretId} has no value`);
  }
  return secret;
}

export function clearConfigCache(): void {
  cachedConfig = undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
