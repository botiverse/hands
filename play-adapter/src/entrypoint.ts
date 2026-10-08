import { WorkerEntrypoint } from "cloudflare:workers";
import { createPlayAdapterService } from "./index";
import type { PlayAdapterEnv, PlayBindingInput, PlayDiscoveryInput, PromotionRpcInput, TrackMaximumRpcInput } from "./types";

export default class GooglePlayAdapter extends WorkerEntrypoint<PlayAdapterEnv> {
  private readonly service = createPlayAdapterService();

  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  }

  listTracks(input: PlayDiscoveryInput) {
    return this.service.listTracks(input, this.env);
  }

  verifyBinding(input: PlayBindingInput) {
    return this.service.verifyBinding(input, this.env);
  }

  listReleaseStates(input: TrackMaximumRpcInput) {
    return this.service.listReleaseStates(input, this.env);
  }

  readTrackMaximum(input: TrackMaximumRpcInput) {
    return this.service.readTrackMaximum(input, this.env);
  }

  promote(input: PromotionRpcInput, body: ReadableStream<Uint8Array>) {
    return this.service.promote(input, body, this.env);
  }
}
