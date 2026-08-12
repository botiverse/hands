import { WorkerEntrypoint } from "cloudflare:workers";
import { getHandsObservabilityOverview } from "./observability_data";

// This service-binding entrypoint deliberately exposes one named aggregate method.
// It does not accept SQL, object prefixes, identifiers, or arbitrary operations.
export class HandsObservability extends WorkerEntrypoint<Env> {
  getOverview() {
    return getHandsObservabilityOverview(this.env);
  }
}
