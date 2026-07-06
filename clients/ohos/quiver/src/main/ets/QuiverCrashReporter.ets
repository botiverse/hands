import { bundleManager, common, errorManager } from '@kit.AbilityKit';
import deviceInfo from '@ohos.deviceInfo';
import fs from '@ohos.file.fs';
import hilog from '@ohos.hilog';
import { QuiverCrashUploader } from './QuiverCrashUploader';

const TAG: string = 'QuiverCrashReporter';
const CRASH_LOG_MAX_CHARS: number = 180000;

/**
 * ArkTS crash capture for HarmonyOS: registers an errorManager observer that
 * writes a crash log + signature sidecar at crash time (store-then-send).
 * Quiver.install() calls this — apps do not use it directly.
 */
export class QuiverCrashReporter {
  private static installed: boolean = false;

  static install(context: common.UIAbilityContext): void {
    if (QuiverCrashReporter.installed) {
      return;
    }
    QuiverCrashReporter.installed = true;
    const observer: errorManager.ErrorObserver = {
      onUnhandledException: (errMsg: string): void => {
        QuiverCrashReporter.capture(context, 'unhandledException', errMsg);
      },
      onException: (errObject: Error): void => {
        QuiverCrashReporter.capture(context, 'exception', QuiverCrashReporter.errorToText(errObject));
      },
    };
    errorManager.on('error', observer);
    hilog.info(0x0000, TAG, 'crash reporter installed');
  }

  private static capture(context: common.UIAbilityContext, reason: string, errorText: string): void {
    try {
      const crashLog = QuiverCrashReporter.buildCrashLog(context, reason, errorText).slice(0, CRASH_LOG_MAX_CHARS);
      const crashPath = QuiverCrashReporter.writeCrashLog(context, crashLog);
      QuiverCrashUploader.enforceRetention(context);
      const firstLine = errorText.split('\n')[0] ?? '';
      const exceptionClass = firstLine.split(':')[0]?.trim() ?? 'OhosCrash';
      const exceptionMessage = firstLine.slice(exceptionClass.length + 1).trim();
      const frameLine = errorText.split('\n').find((line: string): boolean => line.trim().startsWith('at ')) ?? '';
      QuiverCrashUploader.writeMeta(crashPath, {
        exception_class: exceptionClass.length > 0 ? exceptionClass : 'OhosCrash',
        exception_message: exceptionMessage,
        top_frame: frameLine.trim().replace(/^at\s+/, ''),
        reason: reason,
        crash_at: Date.now(),
      });
    } catch (error) {
      hilog.error(0x0000, TAG, 'failed to write crash: %{public}s', String(error));
    }
  }

  private static buildCrashLog(context: common.UIAbilityContext, reason: string, errorText: string): string {
    const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
    const lines: string[] = [
      'Quiver OHOS crash log',
      `Crash at: ${new Date().toString()}`,
      `Bundle: ${bundleInfo.name}`,
      `Version name: ${bundleInfo.versionName}`,
      `Version code: ${bundleInfo.versionCode}`,
      `Device: ${deviceInfo.manufacture} ${deviceInfo.productModel}`.trim(),
      `OS: ${deviceInfo.osFullName} / API ${deviceInfo.sdkApiVersion}`,
      `Reason: ${reason}`,
      '',
      'Error:',
      errorText,
    ];
    return lines.join('\n');
  }

  private static writeCrashLog(context: common.UIAbilityContext, crashLog: string): string {
    const crashDir = `${context.filesDir}/crashes`;
    fs.mkdirSync(crashDir, true);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const crashPath = `${crashDir}/crash-${timestamp}.txt`;
    const file = fs.openSync(crashPath, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY);
    try {
      fs.writeSync(file.fd, crashLog);
    } finally {
      fs.closeSync(file);
    }
    return crashPath;
  }

  private static errorToText(error: Error): string {
    return `${error.name}: ${error.message ?? ''}\n${error.stack ?? ''}`;
  }
}
