/**
 * Build content inventory: what a package contains and what each part costs.
 * See types.ts for the shape; android.ts and ios.ts for the extractors.
 */

import { androidInventory, type AndroidMappingInput } from "./android.js";
import { buildIosInventory } from "./ios.js";
import type { BuildInventory } from "./types.js";

export type { BuildInventory } from "./types.js";
export type { AndroidMappingInput } from "./android.js";

export async function computeInventory(
  platform: "android" | "ios",
  bytes: Uint8Array,
  filePath: string | null = null,
  mapping: AndroidMappingInput = {},
): Promise<BuildInventory> {
  return platform === "android" ? androidInventory(bytes, filePath, mapping) : buildIosInventory(bytes);
}
