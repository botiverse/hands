import { common } from '@kit.AbilityKit';
import fs from '@ohos.file.fs';
import hilog from '@ohos.hilog';
import { QuiverFeedbackClient, QuiverFeedbackExtras } from './QuiverFeedbackClient';

const TAG: string = 'QuiverCrashUploader';
const MAX_STORED_CRASHES: number = 5;

export interface CrashMeta {
  exception_class?: string;
  exception_message?: string;
  top_frame?: string;
  reason?: string;
  crash_at?: number;
}

/**
 * Store-then-send crash reporting for OHOS (mirrors the Android SDK's
 * QuiverCrash): SlockOhosCrashReporter writes crash-<ts>.txt plus a
 * .meta.json sidecar at crash time; this uploader runs on the next launch,
 * submits each pending crash as a kind=crash Quiver ticket (full log
 * attached, signature fields in metadata), and deletes local files on
 * success.
 */
export class QuiverCrashUploader {
  static crashDir(context: common.UIAbilityContext): string {
    return `${context.filesDir}/crashes`;
  }

  /** Write the signature sidecar next to a crash log. */
  static writeMeta(crashPath: string, meta: CrashMeta): void {
    const metaPath = `${crashPath.replace(/\.txt$/, '')}.meta.json`;
    const file = fs.openSync(metaPath, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY);
    try {
      fs.writeSync(file.fd, JSON.stringify(meta));
    } finally {
      fs.closeSync(file);
    }
  }

  /** Delete oldest crashes beyond the retention cap. */
  static enforceRetention(context: common.UIAbilityContext): void {
    const dir = QuiverCrashUploader.crashDir(context);
    if (!fs.accessSync(dir)) {
      return;
    }
    const logs = fs
      .listFileSync(dir)
      .filter((name: string): boolean => name.startsWith('crash-') && name.endsWith('.txt'))
      .sort()
      .reverse();
    for (const name of logs.slice(MAX_STORED_CRASHES - 1)) {
      QuiverCrashUploader.deletePair(`${dir}/${name}`);
    }
  }

  /** Upload all pending crashes; call on launch, off the critical path. */
  static async uploadPending(context: common.UIAbilityContext): Promise<void> {
    const dir = QuiverCrashUploader.crashDir(context);
    if (!fs.accessSync(dir)) {
      return;
    }
    const sidecars = fs
      .listFileSync(dir)
      .filter((name: string): boolean => name.endsWith('.meta.json'))
      .sort();
    for (const sidecarName of sidecars) {
      const sidecarPath = `${dir}/${sidecarName}`;
      const logPath = `${dir}/${sidecarName.replace(/\.meta\.json$/, '')}.txt`;
      if (!fs.accessSync(logPath)) {
        fs.unlinkSync(sidecarPath);
        continue;
      }
      let meta: CrashMeta = {};
      try {
        meta = JSON.parse(fs.readTextSync(sidecarPath)) as CrashMeta;
      } catch (error) {
        hilog.warn(0x0000, TAG, 'meta parse failed for %{public}s', sidecarName);
      }
      const exceptionClass = meta.exception_class ?? 'OhosCrash';
      const topFrame = meta.top_frame ?? '';
      const detail = (meta.exception_message ?? '').slice(0, 200);
      let message = `Crash: ${exceptionClass}`;
      if (detail.length > 0) {
        message = `${message}: ${detail}`;
      }
      if (topFrame.length > 0) {
        message = `${message}\nat ${topFrame}`;
      }
      const extras: QuiverFeedbackExtras[] = [
        { key: 'crash_exception_class', value: exceptionClass },
        { key: 'crash_top_frame', value: topFrame },
        { key: 'crash_reason', value: meta.reason ?? '' },
        { key: 'crash_at', value: String(meta.crash_at ?? 0) },
      ];
      try {
        const ticketId = await QuiverFeedbackClient.submit(context, message, 'crash', [logPath], extras);
        QuiverCrashUploader.deletePair(logPath);
        hilog.info(0x0000, TAG, 'uploaded crash %{public}s as %{public}s', sidecarName, ticketId.slice(0, 8));
      } catch (error) {
        hilog.warn(0x0000, TAG, 'crash upload failed for %{public}s: %{public}s', sidecarName, String(error));
      }
    }
  }

  private static deletePair(logPath: string): void {
    try {
      if (fs.accessSync(logPath)) {
        fs.unlinkSync(logPath);
      }
    } catch (error) {
      hilog.warn(0x0000, TAG, 'delete failed: %{public}s', String(error));
    }
    const metaPath = `${logPath.replace(/\.txt$/, '')}.meta.json`;
    try {
      if (fs.accessSync(metaPath)) {
        fs.unlinkSync(metaPath);
      }
    } catch (error) {
      hilog.warn(0x0000, TAG, 'delete failed: %{public}s', String(error));
    }
  }
}
