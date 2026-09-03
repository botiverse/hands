import { WorkerEntrypoint } from "cloudflare:workers";
import { createPlayAdapterService } from "./index";
import type { PlayAdapterEnv, PlayBindingInput, PromotionRpcInput, TrackMaximumRpcInput } from "./types";

export default class GooglePlayAdapter extends WorkerEntrypoint<PlayAdapterEnv> {
  private readonly service = createPlayAdapterService();

  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }

  verifyBinding(input: PlayBindingInput) {
    return this.service.verifyBinding(input, this.env);
  }

  readTrackMaximum(input: TrackMaximumRpcInput) {
    return this.service.readTrackMaximum(input, this.env);
  }

  promote(input: PromotionRpcInput, body: ReadableStream<Uint8Array>) {
    return this.service.promote(input, body, this.env);
  }
}
