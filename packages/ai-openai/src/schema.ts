export const QuestionSchema = {
  name: 'quiz_question',
  strict: true,
  type: 'json_schema' as const,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      questionId: { type: 'string' },
      category: { type: 'string' },
      prompt: { type: 'string' },
      options: {
        type: 'object',
        additionalProperties: false,
        properties: {
          A: { type: 'string' },
          B: { type: 'string' },
          C: { type: 'string' },
          D: { type: 'string' }
        },
        required: ['A', 'B', 'C', 'D']
      },
      correctOption: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
      explanation: { type: 'string' }
    },
    required: ['questionId', 'category', 'prompt', 'options', 'correctOption', 'explanation']
  }
} as const;
