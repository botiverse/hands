import { bundleManager, common } from '@kit.AbilityKit';
import deviceInfo from '@ohos.deviceInfo';
import http from '@ohos.net.http';
import i18n from '@ohos.i18n';
import hilog from '@ohos.hilog';
import { Quiver } from './Quiver';
import { QuiverDeviceId } from './QuiverDeviceId';

const TAG: string = 'QuiverFeedbackClient';
const REQUEST_TIMEOUT_MS: number = 30000;

export interface QuiverFeedbackExtras {
  key: string;
  value: string;
}

/**
 * Submits feedback / crash tickets to the Quiver feedback endpoint
 * (multipart/form-data) — the OHOS counterpart of the Android SDK's
 * QuiverFeedback. Device and app metadata are attached automatically.
 */
export class QuiverFeedbackClient {
  /**
   * @returns the created ticket id
   */
  static async submit(
    context: common.UIAbilityContext,
    message: string,
    kind: string,
    attachmentPaths: string[],
    extras: QuiverFeedbackExtras[],
  ): Promise<string> {
    const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    const metadata: Record<string, string | number> = {
      'version_name': bundleInfo.versionName,
      'version_code': bundleInfo.versionCode,
      'channel': Quiver.config.channel,
      'device_id': QuiverDeviceId.get(context),
      'device_model': `${deviceInfo.manufacture} ${deviceInfo.productModel}`.trim(),
      'os_version': `${deviceInfo.osFullName} (API ${deviceInfo.sdkApiVersion})`,
      'arch': deviceInfo.abiList ?? 'unknown',
      'locale': i18n.System.getSystemLocale(),
      'platform': 'ohos',
    };
    for (const extra of extras) {
      metadata[extra.key] = extra.value;
    }

    const multiFormDataList: Array<http.MultiFormData> = [
      {
        name: 'message',
        contentType: 'text/plain',
        data: message,
      },
      {
        name: 'kind',
        contentType: 'text/plain',
        data: kind,
      },
      {
        name: 'metadata',
        contentType: 'text/plain',
        data: JSON.stringify(metadata),
      },
    ];
    for (const path of attachmentPaths) {
      const fileName = path.split('/').pop() ?? 'attachment.txt';
      multiFormDataList.push({
        name: 'attachments',
        contentType: 'text/plain',
        remoteFileName: fileName,
        filePath: path,
      });
    }

    const client = http.createHttp();
    try {
      const response = await client.request(
        `${Quiver.config.baseUrl}/public/v2/apps/${Quiver.config.appSlug}/feedback`,
        {
          method: http.RequestMethod.POST,
          header: {
            'Content-Type': 'multipart/form-data',
            'Accept': 'application/json',
            'X-Quiver-Client-Key': Quiver.config.clientKey,
          },
          multiFormDataList: multiFormDataList,
          connectTimeout: REQUEST_TIMEOUT_MS,
          readTimeout: REQUEST_TIMEOUT_MS,
        },
      );
      const code = Number(response.responseCode ?? 0);
      const body = typeof response.result === 'string' ? response.result : '';
      if (code < 200 || code >= 300) {
        hilog.warn(0x0000, TAG, 'feedback submit failed code=%{public}d body=%{public}s', code, body.slice(0, 200));
        throw new Error(`quiver feedback failed: HTTP ${code}`);
      }
      const parsed = JSON.parse(body) as Record<string, string>;
      const ticketId = parsed['id'] ?? '';
      if (ticketId.length === 0) {
        throw new Error('quiver feedback: missing ticket id in response');
      }
      hilog.info(0x0000, TAG, 'feedback submitted ticket=%{public}s kind=%{public}s', ticketId.slice(0, 8), kind);
      return ticketId;
    } finally {
      client.destroy();
    }
  }
}
