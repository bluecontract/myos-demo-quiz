import { z } from 'zod';

export const RoundRequestedEventSchema = z
  .object({
    type: z.literal('Round Requested'),
    nextRoundIndex: z.number().int().nonnegative().optional()
  })
  .passthrough();

export type RoundRequestedEvent = z.infer<typeof RoundRequestedEventSchema>;

const MyOsDocumentPayloadSchema = z
  .object({
    sessionId: z.string(),
    document: z.unknown(),
    emitted: z.array(z.unknown()).optional(),
    epoch: z.number().int().nonnegative().optional()
  })
  .passthrough();

export const MyOsDocumentEpochAdvancedEventSchema = z
  .object({
    type: z.literal('DOCUMENT_EPOCH_ADVANCED'),
    object: MyOsDocumentPayloadSchema
  })
  .passthrough();

export type MyOsDocumentEpochAdvancedEvent = z.infer<typeof MyOsDocumentEpochAdvancedEventSchema>;
export type MyOsDocumentPayload = z.infer<typeof MyOsDocumentPayloadSchema>;
