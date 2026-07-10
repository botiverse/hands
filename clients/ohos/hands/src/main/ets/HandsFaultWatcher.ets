import { common } from '@kit.AbilityKit';
import { hiAppEvent } from '@kit.PerformanceAnalysisKit';
import fs from '@ohos.file.fs';
import hilog from '@ohos.hilog';
import { HandsCrashUploader } from './HandsCrashUploader';

const TAG: string = 'HandsFaultWatcher';
const FAULT_LOG_MAX_CHARS: number = 180000;

/**
 * System-level fault capture via hiAppEvent (the same channel Bugly-class
 * SDKs use on HarmonyOS): subscribes to the OS domain's APP_CRASH and
 * APP_FREEZE events. The SYSTEM records these — native cppcrash included —
 * and delivers them to the watcher on the next launch, so faults that never
 * reach the in-process ArkTS errorManager (which HandsCrashReporter owns)
 * still become Hands crash tickets.
 *
 * Scope split: JsError APP_CRASH events are skipped here because
 * HandsCrashReporter already captured them at crash time — this watcher only
 * reports what errorManager cannot see (NativeCrash, CppCrash, AppFreeze).
 * Hands.install() calls this — apps do not use it directly.
 */
export class HandsFaultWatcher {
  private static installed: boolean = false;

  static install(context: common.UIAbilityContext): void {
    if (HandsFaultWatcher.installed) {
      return;
    }
    HandsFaultWatcher.installed = true;
    try {
      hiAppEvent.addWatcher({
        name: 'hands_fault_watcher',
        appEventFilters: [
          {
            domain: hiAppEvent.domain.OS,
            names: [hiAppEvent.event.APP_CRASH, hiAppEvent.event.APP_FREEZE],
          },
        ],
        onReceive: (domain: string, appEventGroups: Array<hiAppEvent.AppEventGroup>): void => {
          HandsFaultWatcher.onFaultEvents(context, domain, appEventGroups);
        },
      });
      hilog.info(0x0000, TAG, 'fault watcher installed (APP_CRASH + APP_FREEZE)');
    } catch (error) {
      hilog.error(0x0000, TAG, 'failed to install fault watcher: %{public}s', String(error));
    }
  }

  private static onFaultEvents(
    context: common.UIAbilityContext,
    domain: string,
    appEventGroups: Array<hiAppEvent.AppEventGroup>,
  ): void {
    try {
      for (const group of appEventGroups) {
        for (const eventInfo of group.appEventInfos) {
          HandsFaultWatcher.captureFault(context, group.name, eventInfo);
        }
      }
      // Fault events arrive while the app is alive (freeze) or on the launch
      // after a crash — either way an immediate upload attempt is safe.
      HandsCrashUploader.enforceRetention(context);
      HandsCrashUploader.uploadPending(context).catch((): void => {});
    } catch (error) {
      hilog.error(0x0000, TAG, 'failed handling fault events: %{public}s', String(error));
    }
  }

  private static captureFault(
    context: common.UIAbilityContext,
    eventName: string,
    eventInfo: hiAppEvent.AppEventInfo,
  ): void {
    const params = eventInfo.params as Record<string, Object>;
    const crashType = String(params['crash_type'] ?? '');
    // JsError crashes are already captured in-process by HandsCrashReporter;
    // re-reporting them here would duplicate tickets.
    if (eventName === hiAppEvent.event.APP_CRASH && crashType === 'JsError') {
      hilog.info(0x0000, TAG, 'skipping JsError APP_CRASH (errorManager already captured it)');
      return;
    }

    const kind = eventName === hiAppEvent.event.APP_FREEZE ? 'AppFreeze' : (crashType || 'NativeCrash');
    const exception = params['exception'];
    const exceptionText =
      typeof exception === 'string' ? exception : JSON.stringify(exception ?? {}, null, 2);
    const hilogTail = HandsFaultWatcher.joinLines(params['hilog']);
    const threads = params['threads'];
    const threadsText = threads === undefined ? '' : JSON.stringify(threads, null, 2);
    const externalLogs = HandsFaultWatcher.joinLines(params['external_log']);

    const lines: string[] = [
      'Hands OHOS fault log (hiAppEvent)',
      `Event: ${eventName}`,
      `Fault kind: ${kind}`,
      `Fault time: ${new Date(Number(params['time'] ?? Date.now())).toString()}`,
      `Foreground: ${String(params['foreground'] ?? 'unknown')}`,
      `Bundle version: ${String(params['bundle_version'] ?? '')}`,
      `Pid/Uid: ${String(params['pid'] ?? '')}/${String(params['uid'] ?? '')}`,
      '',
      '--- exception ---',
      exceptionText,
    ];
    if (threadsText.length > 0) {
      lines.push('', '--- threads ---', threadsText);
    }
    if (hilogTail.length > 0) {
      lines.push('', '--- hilog ---', hilogTail);
    }
    if (externalLogs.length > 0) {
      lines.push('', '--- system fault log files (on device) ---', externalLogs);
    }
    const crashLog = lines.join('\n').slice(0, FAULT_LOG_MAX_CHARS);

    const crashPath = HandsFaultWatcher.writeFaultLog(context, crashLog);
    const summary = HandsFaultWatcher.exceptionSummary(exception, kind);
    HandsCrashUploader.writeMeta(crashPath, {
      exception_class: summary.cls,
      exception_message: summary.message,
      top_frame: summary.topFrame,
      reason: eventName === hiAppEvent.event.APP_FREEZE ? 'appFreeze' : 'nativeCrash',
      crash_at: Number(params['time'] ?? Date.now()),
    });
    hilog.info(0x0000, TAG, 'captured %{public}s fault', kind);
  }

  private static exceptionSummary(
    exception: Object | undefined,
    kind: string,
  ): SummaryParts {
    const result: SummaryParts = { cls: kind, message: '', topFrame: '' };
    if (exception !== undefined && typeof exception === 'object') {
      const ex = exception as Record<string, Object>;
      const name = String(ex['name'] ?? '');
      const message = String(ex['message'] ?? '');
      const signal = HandsFaultWatcher.describeSignal(ex['signal']);
      if (name.length > 0) {
        result.cls = name;
      } else if (signal.length > 0) {
        result.cls = `${kind}(signal ${signal})`;
      }
      result.message = message;
      const frames = ex['frames'];
      if (Array.isArray(frames)) {
        // The crashing frame is often a bare pc (empty file/symbol); use the
        // first frame that actually names something.
        for (const raw of frames as Array<Object>) {
          const f = raw as Record<string, Object>;
          const symbol = String(f['symbol'] ?? '');
          const file = String(f['file'] ?? '');
          const offset = String(f['offset'] ?? '');
          const label = symbol.length > 0 ? symbol : file;
          if (label.length > 0) {
            result.topFrame = offset.length > 0 ? `${label}+${offset}` : label;
            break;
          }
        }
      }
    }
    return result;
  }

  /**
   * hiAppEvent may deliver the signal as a string or a structured object
   * (e.g. { signal: 11, name: "SIGSEGV" }). String(obj) would produce
   * "[object Object]", so pull out a human name/number instead.
   */
  private static describeSignal(signal: Object | undefined): string {
    if (signal === undefined || signal === null) {
      return '';
    }
    if (typeof signal !== 'object') {
      return String(signal);
    }
    const s = signal as Record<string, Object>;
    const parts: string[] = [];
    const name = s['name'] ?? s['signal_name'];
    const code = s['code'] ?? s['signal'] ?? s['number'];
    if (name !== undefined && name !== null) parts.push(String(name));
    if (code !== undefined && code !== null) parts.push(String(code));
    if (parts.length > 0) {
      return parts.join(' ');
    }
    try {
      return JSON.stringify(signal);
    } catch (error) {
      return 'unknown';
    }
  }

  private static joinLines(value: Object | undefined): string {
    if (value === undefined || value === null) {
      return '';
    }
    if (Array.isArray(value)) {
      return (value as Array<Object>).map((entry: Object): string => String(entry)).join('\n');
    }
    return String(value);
  }

  private static writeFaultLog(context: common.UIAbilityContext, crashLog: string): string {
    const crashDir = `${context.filesDir}/crashes`;
    fs.mkdirSync(crashDir, true);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const crashPath = `${crashDir}/crash-${timestamp}-fault.txt`;
    const file = fs.openSync(crashPath, fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY);
    try {
      fs.writeSync(file.fd, crashLog);
    } finally {
      fs.closeSync(file);
    }
    return crashPath;
  }
}

interface SummaryParts {
  cls: string;
  message: string;
  topFrame: string;
}
