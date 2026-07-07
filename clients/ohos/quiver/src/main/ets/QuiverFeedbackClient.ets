import { bundleManager, common } from '@kit.AbilityKit';
import deviceInfo from '@ohos.deviceInfo';
import http from '@ohos.net.http';
import fs from '@ohos.file.fs';
import i18n from '@ohos.i18n';
import hilog from '@ohos.hilog';
import { Quiver } from './Quiver';
import { QuiverDeviceId } from './QuiverDeviceId';

const TAG: string = 'QuiverFeedbackClient';
const REQUEST_TIMEOUT_MS: number = 30000;
const UPLOAD_TIMEOUT_MS: number = 120000;

/** Server-enforced: at most 9 attachments per ticket. */
const MAX_ATTACHMENTS: number = 9;
/** Files up to this size stream inline in the multipart body. */
const MULTIPART_MAX_BYTES: number = 10 * 1024 * 1024;
/**
 * Files up to this size upload via presigned direct-to-R2 PUT. Capped at
 * 50 MB on OHOS (vs 200 MB on Android/iOS): ArkTS has no file-path raw-PUT
 * API, so the file is read fully into an ArrayBuffer, and a 200 MB upload can
 * spike memory into an OOM process-kill rather than a handleable error. This
 * returns a clean cap error instead. A follow-up will switch to a NAPI/native
 * streaming PUT and raise this to 200 MB.
 */
const PRESIGN_MAX_BYTES: number = 50 * 1024 * 1024;

export interface QuiverFeedbackExtras {
  key: string;
  value: string;
}

interface QuiverPresignUpload {
  attachment_id?: string;
  r2_key?: string;
  upload_url?: string;
  expires_at?: number;
}

interface QuiverPresignResponse {
  uploads?: QuiverPresignUpload[];
}

interface QuiverPresignRequestFile {
  filename: string;
  content_type: string;
  size: number;
}

interface QuiverPresignedRef {
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
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

function readFileBytes(path: string): ArrayBuffer {
  const stat = fs.statSync(path);
  const buffer = new ArrayBuffer(stat.size);
  const file = fs.openSync(path, fs.OpenMode.READ_ONLY);
  try {
    fs.readSync(file.fd, buffer);
  } finally {
    fs.closeSync(file);
  }
  return buffer;
}

/**
 * Submits feedback / crash tickets to the Quiver feedback endpoint
 * (multipart/form-data) — the OHOS counterpart of the Android SDK's
 * QuiverFeedback. Device and app metadata are attached automatically.
 *
 * Attachments: up to 9 files. Small files (<= 10 MB) stream inline in the
 * multipart body. Larger files (up to 50 MB on OHOS) upload directly to R2 via
 * a server-issued presigned URL and are referenced in the ticket, so bigger
 * logs / recordings never pass through the Worker body limit. (Android/iOS
 * stream the presigned PUT and allow up to 200 MB; OHOS reads the file into
 * memory — see PRESIGN_MAX_BYTES.)
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
      // Large attachments go straight to R2 via presigned PUT before the
      // ticket is submitted; the ticket then references them by r2_key.
      const presignedRefs: QuiverPresignedRef[] =
        large.length > 0 ? await QuiverFeedbackClient.uploadLargeAttachments(client, large) : [];

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

  /**
   * Presign + PUT each large file directly to R2, returning the `presigned`
   * refs the submit call references. One presign request covers the batch;
   * the server returns upload URLs in the same order as the request.
   */
  private static async uploadLargeAttachments(
    client: http.HttpRequest,
    paths: string[],
  ): Promise<QuiverPresignedRef[]> {
    const requestFiles: QuiverPresignRequestFile[] = paths.map((path): QuiverPresignRequestFile => {
      const fileName = path.split('/').pop() ?? 'attachment';
      return {
        filename: fileName,
        content_type: guessContentType(fileName),
        size: fileSize(path),
      };
    });

    const presignResponse = await client.request(
      `${Quiver.config.baseUrl}/public/v2/apps/${Quiver.config.appSlug}/feedback/presign`,
      {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Quiver-Client-Key': Quiver.config.clientKey,
        },
        extraData: JSON.stringify({ files: requestFiles }),
        connectTimeout: REQUEST_TIMEOUT_MS,
        readTimeout: REQUEST_TIMEOUT_MS,
      },
    );
    const presignCode = Number(presignResponse.responseCode ?? 0);
    const presignBody = typeof presignResponse.result === 'string' ? presignResponse.result : '';
    if (presignCode < 200 || presignCode >= 300) {
      throw new Error(`quiver presign failed: HTTP ${presignCode}`);
    }
    const uploads = (JSON.parse(presignBody) as QuiverPresignResponse).uploads ?? [];

    const refs: QuiverPresignedRef[] = [];
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index];
      const fileName = path.split('/').pop() ?? 'attachment';
      const upload = uploads[index];
      const uploadUrl = upload?.upload_url ?? '';
      const r2Key = upload?.r2_key ?? '';
      if (uploadUrl.length === 0 || r2Key.length === 0) {
        throw new Error(`quiver presign entry ${index} missing upload_url/r2_key`);
      }
      const contentType = guessContentType(fileName);
      // The presigned PUT signs the content-type, so it must match exactly.
      const putResponse = await client.request(uploadUrl, {
        method: http.RequestMethod.PUT,
        header: { 'Content-Type': contentType },
        extraData: readFileBytes(path),
        connectTimeout: REQUEST_TIMEOUT_MS,
        readTimeout: UPLOAD_TIMEOUT_MS,
      });
      const putCode = Number(putResponse.responseCode ?? 0);
      if (putCode < 200 || putCode >= 300) {
        throw new Error(`quiver R2 upload failed for ${fileName}: HTTP ${putCode}`);
      }
      refs.push({
        r2_key: r2Key,
        filename: fileName,
        content_type: contentType,
        size: fileSize(path),
      });
    }
    return refs;
  }
}
