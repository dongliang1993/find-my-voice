import { z } from 'zod';
import type { ClientEvent } from '../../shared/protocol.js';

export const clientEventSchema: z.ZodType<ClientEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send'), clientId: z.uuid(), text: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('presence'), visible: z.boolean() }),
  z.object({ type: z.literal('reading'), paperId: z.string().min(1).max(80).nullable() }),
  z.object({ type: z.literal('wake') }),
]);
