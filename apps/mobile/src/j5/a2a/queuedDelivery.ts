import {
  formatJ5QueuedDelivery,
  participantIdsForJ5Envelope,
} from "@t3tools/client-runtime/j5/participant-identity";
import type { EnvironmentId } from "@t3tools/contracts";

import { useParticipantIdentities } from "./participantIdentities";

/**
 * "Up next" rows for queued deliveries: `From <sender>: <first line>` instead of the envelope.
 * The returned function answers null for a row that is not a delivery.
 */
export function useJ5QueuedDeliveryLabel(
  environmentId: EnvironmentId,
  texts: ReadonlyArray<string>,
): (text: string) => string | null {
  const { labels } = useParticipantIdentities(
    environmentId,
    texts.flatMap((text) => participantIdsForJ5Envelope(text)),
  );
  return (text) => formatJ5QueuedDelivery(text, labels)?.label ?? null;
}
