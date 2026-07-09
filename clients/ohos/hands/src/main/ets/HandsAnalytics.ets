import { bundleManager, common } from '@kit.AbilityKit';
import deviceInfo from '@ohos.deviceInfo';
import http from '@ohos.net.http';
import i18n from '@ohos.i18n';
import preferences from '@ohos.data.preferences';
import hilog from '@ohos.hilog';
import { Hands } from './Hands';
import { HandsDeviceId } from './HandsDeviceId';

const TAG: string = 'HandsAnalytics';
const PREFS_NAME: string = 'quiver_update';
const KEY_LAST_PING: string = 'last_device_ping_at';
const MIN_INTERVAL_MS: number = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS: number = 15000;

/**
 * Device registration ping for active-device / version-distribution
 * analytics. Throttled to once per 24h per install (timestamp in the same
 * preferences store as the device id). No PII — random device id + build/OS
 * metadata only. Fired automatically by Hands.install().
 */
export class HandsAnalytics {
  static async reportDevice(context: common.UIAbilityContext, force: boolean = false): Promise<boolean> {
    const store = preferences.getPreferencesSync(context, { name: PREFS_NAME });
    const now = Date.now();
    if (!force) {
      const last = store.getSync(KEY_LAST_PING, 0) as number;
      if (last > 0 && now - last < MIN_INTERVAL_MS) {
        return false;
      }
    }

    const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    const metadata: Record<string, string | number> = {
      'version_name': bundleInfo.versionName,
      'version_code': bundleInfo.versionCode,
      'channel': Hands.config.channel,
      'platform': 'ohos',
      'arch': deviceInfo.abiList ?? 'unknown',
      'os_version': `${deviceInfo.osFullName} (API ${deviceInfo.sdkApiVersion})`,
      'device_model': `${deviceInfo.manufacture} ${deviceInfo.productModel}`.trim(),
      'locale': i18n.System.getSystemLocale(),
    };

    const client = http.createHttp();
    try {
      const response = await client.request(
        `${Hands.config.baseUrl}/public/v2/apps/${Hands.config.appSlug}/metrics`,
        {
          method: http.RequestMethod.POST,
          header: {
            'Content-Type': 'application/json',
            'X-Hands-Client-Key': Hands.config.clientKey,
            'X-Hands-Device-Id': HandsDeviceId.get(context),
          },
          extraData: JSON.stringify(metadata),
          connectTimeout: REQUEST_TIMEOUT_MS,
          readTimeout: REQUEST_TIMEOUT_MS,
        },
      );
      const code = Number(response.responseCode ?? 0);
      if (code >= 200 && code < 300) {
        store.putSync(KEY_LAST_PING, now);
        store.flush();
        return true;
      }
      hilog.warn(0x0000, TAG, 'device ping failed code=%{public}d', code);
      return false;
    } catch (error) {
      hilog.warn(0x0000, TAG, 'device ping error: %{public}s', String(error));
      return false;
    } finally {
      client.destroy();
    }
  }
}
