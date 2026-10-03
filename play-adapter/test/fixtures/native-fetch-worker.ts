import { createPlayAdapterService } from "../../src/index";
export default {
  async fetch(): Promise<Response> {
    const service = createPlayAdapterService(); // Use the runtime's native fetch.
    const result = await service.listTracks({
      credential: { type: "authorized_user", client_id: "test", client_secret: "test", refresh_token: "test", client_email: "test@example.invalid" },
      packageName: "build.test.app",
    }, { MAX_AAB_SIZE_BYTES: "209715200" });
    return Response.json(result);
  },
};
