import { common } from '@kit.AbilityKit';
import dataPreferences from '@ohos.data.preferences';
import util from '@ohos.util';

const PREFS_NAME: string = 'quiver_update';
const KEY_DEVICE_ID: string = 'device_id';

/**
 * Stable per-install device id used for staged rollouts and ticket
 * correlation — mirrors the Android SDK's QuiverDeviceId.
 */
export class HandsDeviceId {
  private static cached: string | null = null;

  static get(context: common.UIAbilityContext): string {
    if (HandsDeviceId.cached !== null) {
      return HandsDeviceId.cached;
    }
    const prefs = dataPreferences.getPreferencesSync(context, { name: PREFS_NAME });
    const existing = prefs.getSync(KEY_DEVICE_ID, '') as string;
    if (existing.length > 0) {
      HandsDeviceId.cached = existing;
      return existing;
    }
    const created = util.generateRandomUUID(true);
    prefs.putSync(KEY_DEVICE_ID, created);
    prefs.flush();
    HandsDeviceId.cached = created;
    return created;
  }
}
