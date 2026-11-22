/**
 * Google Play's four kinds of track, as Hands names them internally. Callers
 * may also use Play's own track ids: `alpha` is closed testing and `beta` is
 * open testing (Play's fixed id for it).
 */
export const HANDS_PLAY_TRACKS = ["internal", "closed", "open", "production"] as const;
export type HandsPlayTrack = (typeof HANDS_PLAY_TRACKS)[number];

/** Play's track id for open testing; it is the same for every app. */
export const OPEN_TESTING_PLAY_TRACK = "beta";

const ALIASES: Record<string, HandsPlayTrack> = {
  internal: "internal",
  closed: "closed",
  alpha: "closed",
  open: "open",
  beta: "open",
  production: "production",
};

/** The Hands track for a requested name (Hands or Play id), or null. */
export function normalizeHandsPlayTrack(value: unknown): HandsPlayTrack | null {
  return typeof value === "string" ? ALIASES[value.trim().toLowerCase()] ?? null : null;
}

export const PLAY_TRACK_CHOICES = "internal, alpha (closed testing), beta (open testing) or production";

/** Tracks with staged (percentage) rollouts. */
export function supportsPartialRollout(track: HandsPlayTrack): boolean {
  return track === "production" || track === "open";
}
