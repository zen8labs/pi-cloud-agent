import { z } from "zod";

/** Provider-neutral origin metadata retained for replay and idempotency. */
export const provenanceSchema = z.object({
  source: z.string().min(1).max(80),
  deliveryId: z.string().min(1).max(200).optional(),
  eventType: z.string().min(1).max(120).optional(),
  action: z.string().min(1).max(120).optional(),
  externalThreadKey: z.string().min(1).max(500).optional(),
  /** Opaque installation/account binding used by the provider adapter. */
  integrationId: z.string().min(1).max(200).optional(),
  /** External message/comment id for an asynchronous reply target. */
  externalMessageId: z.string().min(1).max(200).optional(),
  /** External actor/login retained for audit and reply context. */
  externalActor: z.string().min(1).max(200).optional(),
});

export type Provenance = z.infer<typeof provenanceSchema>;
