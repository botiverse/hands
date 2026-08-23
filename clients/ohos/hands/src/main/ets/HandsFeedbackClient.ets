import { bundleManager, common } from '@kit.AbilityKit';
import deviceInfo from '@ohos.deviceInfo';
import http from '@ohos.net.http';
import fs from '@ohos.file.fs';
import i18n from '@ohos.i18n';
import hilog from '@ohos.hilog';
import display from '@ohos.display';
import statvfs from '@ohos.file.statvfs';
import batteryInfo from '@ohos.batteryInfo';
import { Hands } from './Hands';
import { HANDS_OHOS_SDK_VERSION } from './HandsCrashStoragePolicy';
import { HandsDeviceId } from './HandsDeviceId';
import {
  HANDS_OHOS_PRESIGN_MAX_BYTES,
  HANDS_OHOS_MULTIPART_MAX_ATTEMPTS,
  HANDS_OHOS_MULTIPART_PART_BYTES,
  handsOhosMultipartPartCount,
  handsOhosMultipartPartLength,
} from './HandsOhosStreamingUploadPolicy';

const TAG: string = 'HandsFeedbackClient';

// @ohos.batteryInfo BatteryChargeState: NONE=0, ENABLE=1, DISABLE=2, FULL=3.
function ohBatteryStateName(status: number): string {
  switch (status) {
    case 1: return 'charging';
    case 2: return 'discharging';
    case 3: return 'full';
    default: return 'unknown';
  }
}
const REQUEST_TIMEOUT_MS: number = 30000;
const UPLOAD_TIMEOUT_MS: number = 120000;
const STREAM_UPLOAD_TIMEOUT_MS: number = 10 * 60 * 1000;

/** Server-enforced: at most 9 attachments per ticket. */
const MAX_ATTACHMENTS: number = 9;
/** Files up to this size stream inline in the multipart body. */
const MULTIPART_MAX_BYTES: number = 10 * 1024 * 1024;
/** Files up to this size upload through a bounded R2 multipart session. */
const PRESIGN_MAX_BYTES: number = HANDS_OHOS_PRESIGN_MAX_BYTES;

export interface HandsFeedbackExtras {
  key: string;
  value: string;
}

interface HandsPresignUpload {
  attachment_id?: string;
  r2_key?: string;
  upload_id?: string;
  part_size?: number;
}

interface HandsPresignResponse {
  uploads?: HandsPresignUpload[];
}

interface HandsPresignRequestFile {
  filename: string;
  content_type: string;
  size: number;
}

interface HandsPresignedRef {
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
}

interface HandsUploadedPart {
  part_number: number;
  etag: string;
}

interface HandsUploadedPartResponse {
  part_number?: number;
  etag?: string;
  size?: number;
}

function guessContentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain';
  if (lower.endsWith('.json') || lower.endsWith('.jsonl')) return 'application/json';
  if (lower.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

function fileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch (err) {
    return 0;
  }
}

/**
 * Submits feedback / crash tickets to the Hands feedback endpoint
 * (multipart/form-data) — the OHOS counterpart of the Android SDK's
 * QuiverFeedback. Device and app metadata are attached automatically.
 *
 * Attachments: up to 9 files. Small files (<= 10 MB) stream inline in the
 * multipart body. Larger files (up to 200 MB) are read and uploaded as 5 MiB
 * raw parts through an R2 multipart session. Only one part enters the ArkTS
 * heap at a time; the complete attachment is never materialized in memory.
 */
export class HandsFeedbackClient {
  /**
   * @returns the created ticket id
   */
  static async submit(
    context: common.UIAbilityContext,
    message: string,
    kind: string,
    attachmentPaths: string[],
    extras: HandsFeedbackExtras[],
  ): Promise<string> {
    const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    const metadata: Record<string, string | number> = {
      // App / build identity
      'version_name': bundleInfo.versionName,
      'version_code': bundleInfo.versionCode,
      'bundle_id': bundleInfo.name,
      'platform': 'ohos',
      'hands_sdk': HANDS_OHOS_SDK_VERSION,
      'channel': Hands.config.channel,
      // Device
      'device_id': HandsDeviceId.get(context),
      'device_model': `${deviceInfo.manufacture} ${deviceInfo.productModel}`.trim(),
      'device_manufacturer': deviceInfo.manufacture,
      'device_brand': deviceInfo.brand,
      'device_type': deviceInfo.deviceType,
      'market_name': deviceInfo.marketName,
      // OS
      'os': deviceInfo.osFullName,
      'os_version': `${deviceInfo.osFullName} (API ${deviceInfo.sdkApiVersion})`,
      'sdk_api_version': deviceInfo.sdkApiVersion,
      'arch': deviceInfo.abiList ?? 'unknown',
      'locale': i18n.System.getSystemLocale(),
      'system_language': i18n.System.getSystemLanguage(),
    };

    // Runtime state (best-effort; a metadata read must never fail submit).
    try {
      metadata['timezone'] = i18n.getTimeZone().getID();
    } catch (e) { /* ignore */ }
    try {
      const screen = display.getDefaultDisplaySync();
      metadata['screen'] = `${screen.width}x${screen.height}@${screen.densityDPI}`;
    } catch (e) { /* ignore */ }
    try {
      metadata['disk_total'] = statvfs.getTotalSizeSync(context.filesDir);
      metadata['disk_free'] = statvfs.getFreeSizeSync(context.filesDir);
    } catch (e) { /* ignore */ }
    try {
      metadata['battery_level'] = batteryInfo.batterySOC;
      metadata['battery_state'] = ohBatteryStateName(batteryInfo.chargingStatus);
    } catch (e) { /* ignore */ }

    // Caller extras (crash_* fields etc.) override/augment the above.
    for (const extra of extras) {
      metadata[extra.key] = extra.value;
    }

    const selected = attachmentPaths.filter((p) => fileSize(p) > 0).slice(0, MAX_ATTACHMENTS);
    for (const path of selected) {
      if (fileSize(path) > PRESIGN_MAX_BYTES) {
        throw new Error(`attachment ${path} exceeds the ${PRESIGN_MAX_BYTES / (1024 * 1024)} MB limit`);
      }
    }
    const inline = selected.filter((p) => fileSize(p) <= MULTIPART_MAX_BYTES);
    const large = selected.filter((p) => fileSize(p) > MULTIPART_MAX_BYTES);

    const client = http.createHttp();
    try {
      // Large attachments complete an R2 multipart upload before the ticket
      // is submitted; the ticket then references them by r2_key.
      const presignedRefs: HandsPresignedRef[] =
        large.length > 0 ? await HandsFeedbackClient.uploadLargeAttachments(client, large) : [];

      const multiFormDataList: Array<http.MultiFormData> = [
        { name: 'message', contentType: 'text/plain', data: message },
        { name: 'kind', contentType: 'text/plain', data: kind },
        { name: 'metadata', contentType: 'text/plain', data: JSON.stringify(metadata) },
      ];
      for (const path of inline) {
        const fileName = path.split('/').pop() ?? 'attachment';
        multiFormDataList.push({
          name: 'attachments',
          contentType: guessContentType(fileName),
          remoteFileName: fileName,
          filePath: path,
        });
      }
      if (presignedRefs.length > 0) {
        multiFormDataList.push({
          name: 'presigned',
          contentType: 'application/json',
          data: JSON.stringify(presignedRefs),
        });
      }

      const response = await client.request(
        `${Hands.config.baseUrl}/public/v2/apps/${Hands.config.appSlug}/feedback`,
        {
          method: http.RequestMethod.POST,
          header: {
            'Content-Type': 'multipart/form-data',
            'Accept': 'application/json',
            'X-Hands-Client-Key': Hands.config.clientKey,
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
        throw new Error(`Hands feedback failed: HTTP ${code}`);
      }
      const parsed = JSON.parse(body) as Record<string, string>;
      const ticketId = parsed['id'] ?? '';
      if (ticketId.length === 0) {
        throw new Error('Hands feedback: missing ticket id in response');
      }
      hilog.info(0x0000, TAG, 'feedback submitted ticket=%{public}s kind=%{public}s', ticketId.slice(0, 8), kind);
      return ticketId;
    } finally {
      client.destroy();
    }
  }

  /**
   * Starts one R2 multipart session per large file and uploads bounded raw
   * parts through the Worker. One start request covers the batch.
   */
  private static async uploadLargeAttachments(
    client: http.HttpRequest,
    paths: string[],
  ): Promise<HandsPresignedRef[]> {
    const requestFiles: HandsPresignRequestFile[] = paths.map((path): HandsPresignRequestFile => {
      const fileName = path.split('/').pop() ?? 'attachment';
      return {
        filename: fileName,
        content_type: guessContentType(fileName),
        size: fileSize(path),
      };
    });

    const presignResponse = await client.request(
      `${Hands.config.baseUrl}/public/v2/apps/${Hands.config.appSlug}/feedback/presign`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Hands-Client-Key': Hands.config.clientKey,
        },
        extraData: JSON.stringify({ files: requestFiles, upload_mode: 'r2_multipart_proxy' }),
        connectTimeout: REQUEST_TIMEOUT_MS,
        readTimeout: REQUEST_TIMEOUT_MS,
      },
    );
    const presignCode = Number(presignResponse.responseCode ?? 0);
    const presignBody = typeof presignResponse.result === 'string' ? presignResponse.result : '';
    if (presignCode < 200 || presignCode >= 300) {
      throw new Error(`Hands presign failed: HTTP ${presignCode}`);
    }
    const uploads = (JSON.parse(presignBody) as HandsPresignResponse).uploads ?? [];

    const refs: HandsPresignedRef[] = [];
    let activeIndex = 0;
    try {
      for (; activeIndex < paths.length; activeIndex++) {
        const path = paths[activeIndex];
        const fileName = path.split('/').pop() ?? 'attachment';
        const upload = uploads[activeIndex];
        const r2Key = upload?.r2_key ?? '';
        const uploadId = upload?.upload_id ?? '';
        const partSize = upload?.part_size ?? 0;
        if (uploadId.length === 0 || r2Key.length === 0 || partSize !== HANDS_OHOS_MULTIPART_PART_BYTES) {
          throw new Error(`Hands multipart entry ${activeIndex} is incomplete`);
        }
        const contentType = guessContentType(fileName);
        await HandsFeedbackClient.uploadMultipartFile(client, path, fileName, r2Key, uploadId, partSize);
        refs.push({
          r2_key: r2Key,
          filename: fileName,
          content_type: contentType,
          size: fileSize(path),
        });
      }
    } catch (error) {
      const pendingAborts: Promise<void>[] = [];
      for (let pendingIndex = activeIndex; pendingIndex < uploads.length; pendingIndex++) {
        const pending = uploads[pendingIndex];
        const pendingKey = pending?.r2_key ?? '';
        const pendingId = pending?.upload_id ?? '';
        if (pendingKey.length > 0 && pendingId.length > 0) {
          pendingAborts.push(HandsFeedbackClient.abortMultipartUpload(client, pendingKey, pendingId));
        }
      }
      await Promise.all(pendingAborts);
      throw error instanceof Error ? error : new Error(String(error));
    }
    return refs;
  }

  private static async uploadMultipartFile(
    client: http.HttpRequest,
    path: string,
    fileName: string,
    r2Key: string,
    uploadId: string,
    partSize: number,
  ): Promise<void> {
    const declaredBytes = fileSize(path);
    const partCount = handsOhosMultipartPartCount(declaredBytes);
    if (partCount === 0 || partSize !== HANDS_OHOS_MULTIPART_PART_BYTES) {
      throw new Error(`Hands multipart upload has invalid size for ${fileName}`);
    }
    const uploadedParts: HandsUploadedPart[] = [];
    const startedAt = Date.now();
    try {
      for (let partIndex = 0; partIndex < partCount; partIndex++) {
        if (Date.now() - startedAt > STREAM_UPLOAD_TIMEOUT_MS) {
          throw new Error(`Hands multipart upload timed out for ${fileName}`);
        }
        const partLength = handsOhosMultipartPartLength(declaredBytes, partIndex);
        const part = await HandsFeedbackClient.uploadMultipartPart(
          client,
          path,
          fileName,
          r2Key,
          uploadId,
          partIndex,
          partLength,
          declaredBytes,
        );
        uploadedParts.push(part);
        hilog.debug(
          0x0000,
          TAG,
          'R2 multipart progress file=%{public}s sent=%{public}d total=%{public}d',
          fileName,
          Math.min(declaredBytes, (partIndex + 1) * partSize),
          declaredBytes,
        );
      }
      await HandsFeedbackClient.completeMultipartUpload(client, r2Key, uploadId, declaredBytes, uploadedParts);
    } catch (error) {
      await HandsFeedbackClient.abortMultipartUpload(client, r2Key, uploadId);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private static async uploadMultipartPart(
    client: http.HttpRequest,
    path: string,
    fileName: string,
    r2Key: string,
    uploadId: string,
    partIndex: number,
    partLength: number,
    declaredBytes: number,
  ): Promise<HandsUploadedPart> {
    let lastError: Error = new Error(`Hands multipart part failed for ${fileName}`);
    for (let attempt = 1; attempt <= HANDS_OHOS_MULTIPART_MAX_ATTEMPTS; attempt++) {
      try {
        if (fileSize(path) !== declaredBytes) throw new Error(`Hands attachment changed during upload: ${fileName}`);
        const offset = partIndex * HANDS_OHOS_MULTIPART_PART_BYTES;
        const bytes = await HandsFeedbackClient.readFilePart(path, offset, partLength);
        const url = `${Hands.config.baseUrl}/public/v2/apps/${Hands.config.appSlug}/feedback/multipart/part` +
          `?r2_key=${encodeURIComponent(r2Key)}&upload_id=${encodeURIComponent(uploadId)}` +
          `&part_number=${partIndex + 1}`;
        const response = await client.request(url, {
          method: http.RequestMethod.PUT,
          header: {
            'Content-Type': 'application/octet-stream',
            'Accept': 'application/json',
            'X-Hands-Client-Key': Hands.config.clientKey,
            'X-Hands-Part-Bytes': String(partLength),
          },
          extraData: bytes,
          connectTimeout: REQUEST_TIMEOUT_MS,
          readTimeout: UPLOAD_TIMEOUT_MS,
        });
        const code = Number(response.responseCode ?? 0);
        const body = typeof response.result === 'string' ? response.result : '';
        if (code < 200 || code >= 300) throw new Error(`HTTP ${code}`);
        const parsed = JSON.parse(body) as HandsUploadedPartResponse;
        const etag = parsed.etag ?? '';
        if (parsed.part_number !== partIndex + 1 || parsed.size !== partLength || etag.length === 0) {
          throw new Error('invalid part receipt');
        }
        return { part_number: partIndex + 1, etag: etag };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < HANDS_OHOS_MULTIPART_MAX_ATTEMPTS) {
          hilog.warn(0x0000, TAG, 'R2 part retry file=%{public}s part=%{public}d', fileName, partIndex + 1);
        }
      }
    }
    throw lastError;
  }

  private static async readFilePart(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    const file = fs.openSync(path);
    try {
      fs.lseek(file.fd, offset);
      const buffer = new ArrayBuffer(length);
      const readBytes = await fs.read(file.fd, buffer, { length: length });
      if (readBytes !== length) {
        throw new Error(`Hands attachment changed during upload: expected ${length}, read ${readBytes}`);
      }
      return buffer;
    } finally {
      fs.closeSync(file);
    }
  }

  private static async completeMultipartUpload(
    client: http.HttpRequest,
    r2Key: string,
    uploadId: string,
    size: number,
    parts: HandsUploadedPart[],
  ): Promise<void> {
    const response = await client.request(
      `${Hands.config.baseUrl}/public/v2/apps/${Hands.config.appSlug}/feedback/multipart/complete`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Hands-Client-Key': Hands.config.clientKey,
        },
        extraData: JSON.stringify({ r2_key: r2Key, upload_id: uploadId, size: size, parts: parts }),
        connectTimeout: REQUEST_TIMEOUT_MS,
        readTimeout: UPLOAD_TIMEOUT_MS,
      },
    );
    const code = Number(response.responseCode ?? 0);
    if (code < 200 || code >= 300) throw new Error(`Hands multipart completion failed: HTTP ${code}`);
  }

  private static async abortMultipartUpload(
    client: http.HttpRequest,
    r2Key: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await client.request(
        `${Hands.config.baseUrl}/public/v2/apps/${Hands.config.appSlug}/feedback/multipart/abort`,
        {
          method: http.RequestMethod.POST,
          header: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-Hands-Client-Key': Hands.config.clientKey,
          },
          extraData: JSON.stringify({ r2_key: r2Key, upload_id: uploadId }),
          connectTimeout: REQUEST_TIMEOUT_MS,
          readTimeout: REQUEST_TIMEOUT_MS,
        },
      );
    } catch {
      // The upload has already failed. Abort is best-effort cleanup and must
      // not replace the causal transport error returned to the caller.
    }
  }
}
