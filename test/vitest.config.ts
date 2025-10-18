import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  resolve: {
    alias: {
      '@myos-quiz/core': path.join(workspaceRoot, 'packages/core/src'),
      '@myos-quiz/ai-openai': path.join(workspaceRoot, 'packages/ai-openai/src'),
      '@myos-quiz/myos-http': path.join(workspaceRoot, 'packages/myos-http/src'),
      '@myos-quiz/persistence-ddb': path.join(workspaceRoot, 'packages/persistence-ddb/src'),
      '@myos-quiz/webhook': path.join(workspaceRoot, 'packages/webhook/src')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['unit/**/*.spec.ts', 'integration/**/*.spec.ts'],
    setupFiles: [],
    server: {
      deps: {
        inline: [
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/lib-dynamodb',
          '@aws-sdk/client-secrets-manager',
          'aws-sdk-client-mock'
        ]
      }
    },
    reporters: ['verbose'],
  }
});
