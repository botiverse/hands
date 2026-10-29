import { WorkerEntrypoint } from "cloudflare:workers";
import { createPlayAdapterService } from "./index";
import type {
  PlayAdapterEnv,
  PlayBindingInput,
  PlayDiscoveryInput,
  PromotionRpcInput,
  SendForReviewRpcInput,
  StoreListingPushRpcInput,
  StoreListingReadRpcInput,
  TrackMaximumRpcInput,
  UploadDeobfuscationRpcInput,
} from "./types";

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

  readStoreListings(input: StoreListingReadRpcInput) {
    return this.service.readStoreListings(input, this.env);
  }

  pushStoreListings(input: StoreListingPushRpcInput) {
    return this.service.pushStoreListings(input, this.env);
  }

  sendForReview(input: SendForReviewRpcInput) {
    return this.service.sendForReview(input, this.env);
  }

  uploadDeobfuscation(
    input: UploadDeobfuscationRpcInput,
    mappingBody?: ReadableStream<Uint8Array> | null,
    symbolsBody?: ReadableStream<Uint8Array> | null,
  ) {
    return this.service.uploadDeobfuscation(input, this.env, mappingBody ?? null, symbolsBody ?? null);
  }

  readTrackMaximum(input: TrackMaximumRpcInput) {
    return this.service.readTrackMaximum(input, this.env);
  }

  promote(
    input: PromotionRpcInput,
    body: ReadableStream<Uint8Array>,
    symbolsBody: ReadableStream<Uint8Array> | null,
    mappingBody?: ReadableStream<Uint8Array> | null,
  ) {
    return this.service.promote(input, body, symbolsBody ?? null, this.env, mappingBody ?? null);
  }
}
