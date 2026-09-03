export type HandsTrack = "internal" | "closed" | "production";

export interface PlayAdapterEnv {
  /** Google service-account JSON; set only with `wrangler secret put`. */
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?: string;
  /** Comma-separated package names accepted from the Hands service binding. */
  ALLOWED_PACKAGE_NAMES?: string;
  /** Existing Play Console closed-testing track identifier. */
  GOOGLE_PLAY_CLOSED_TRACK_NAME?: string;
  /** Maximum streamed AAB size accepted from Hands. */
  MAX_AAB_SIZE_BYTES?: string;
}

export interface ServiceAccountCredential {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

export interface TrackRelease {
  name?: string;
  versionCodes?: string[];
  releaseNotes?: Array<{ language: string; text: string }>;
  status?: "statusUnspecified" | "draft" | "inProgress" | "halted" | "completed";
  userFraction?: number;
  countryTargeting?: { countries?: string[]; includeRestOfWorld?: boolean };
  inAppUpdatePriority?: number;
}

export interface TrackResource {
  track?: string;
  releases?: TrackRelease[];
}

export interface PromotionRequest {
  packageName: string;
  handsTrack: HandsTrack;
  playTrack: string;
  versionCode: number;
  expectedSha256: string;
  expectedSize: number;
  rolloutPercent: number;
  operationId: string;
  body: ReadableStream<Uint8Array>;
}
