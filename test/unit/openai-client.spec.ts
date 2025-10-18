import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { OpenAiClient } from '@myos-quiz/ai-openai';

const apiBase = 'https://api.openai.com';

describe('OpenAiClient', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'gpt-test';
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('calls Responses API with structured outputs schema and parses response', async () => {
    const expectedResponse = {
      questionId: 'q-789',
      category: 'Science',
      prompt: 'What is H2O?',
      options: { A: 'Water', B: 'Oxygen', C: 'Hydrogen', D: 'Helium' },
      correctOption: 'A',
      explanation: 'H2O is water.'
    };

    const scope = nock(apiBase)
      .post('/v1/responses', body => {
        expect(body).toMatchObject({
          model: 'gpt-test',
          text: {
            format: {
              type: 'json_schema',
              name: 'quiz_question',
              strict: true
            }
          }
        });
        expect(body.text.format.schema).toMatchObject({
          type: 'object',
          properties: expect.any(Object)
        });
        return true;
      })
      .reply(200, {
        id: 'resp_123',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(expectedResponse)
              }
            ]
          }
        ]
      });

    const client = new OpenAiClient();
    const result = await client.generateQuestion({ categories: ['Science'], level: 0 });

    expect(result).toEqual(expectedResponse);
    expect(scope.isDone()).toBe(true);
  });
});
