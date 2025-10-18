import { z } from 'zod';

export const ChoiceSchema = z.enum(['A', 'B', 'C', 'D']);
export type Choice = z.infer<typeof ChoiceSchema>;

export const OptionsSchema = z
  .object({
    A: z.string(),
    B: z.string(),
    C: z.string(),
    D: z.string()
  })
  .passthrough();

export interface Question {
  questionId: string;
  category: string;
  prompt: string;
  options: Record<Choice, string>;
}

export interface RoundResult {
  correctOption: Choice;
  explanation?: string;
}

export type GeneratedQuestion = Question & RoundResult;

const AnswerSchema = z
  .object({
    choice: ChoiceSchema.optional()
  })
  .passthrough();

export const DocumentSnapshotSchema = z
  .object({
    sessionId: z.string(),
    roundsTotal: z.number().int().nonnegative().optional(),
    roundIndex: z.number().int().nonnegative(),
    level: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
    categories: z.array(z.string()).default([]),
    phase: z.enum(['IN_ROUND', 'BETWEEN_ROUNDS', 'GAME_COMPLETED']).optional(),
    currentQuestion: z
      .object({
        questionId: z.string().optional(),
        prompt: z.string().optional(),
        options: z
          .record(ChoiceSchema, z.string())
          .or(OptionsSchema)
          .optional()
      })
      .partial()
      .passthrough()
      .optional(),
    answers: z
      .record(z.string(), AnswerSchema)
      .or(
        z
          .object({
            playerA: AnswerSchema.optional(),
            playerB: AnswerSchema.optional()
          })
          .passthrough()
      )
      .optional(),
    emitted: z.array(z.object({ type: z.string().or(z.object({ blueId: z.string() })) }).passthrough()).optional()
  })
  .extend({
    timelineIds: z.array(z.string()).optional(),
    document: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough();

export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;
