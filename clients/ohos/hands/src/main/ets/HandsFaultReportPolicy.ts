/**
 * Pure decisions for OHOS crash tickets. hiAppEvent delivers native crashes
 * on the next launch, which may already be a different install. These helpers
 * keep the signal number and the crashed build identity off that later process.
 */

export interface HandsCapturedBuild {
  versionName?: string;
  versionCode?: number | null;
}

export interface StoredCrashBuild {
  versionName: string;
  versionCode: number | null;
}

export interface StoredCrashBuildKeys {
  versionName: boolean;
  versionCode: boolean;
}

export interface FaultBuildIdentity {
  versionName: string;
  versionCode: number | null;
}

export interface TicketBuildFields {
  versionName: string | null;
  versionCode: number | null;
}

type SignalValue = Object | string | number | null | undefined;

/**
 * hiAppEvent `signal` is `{ signo, code, address }`.
 * `signo` is the signal number (11 = SIGSEGV). `code` is si_code
 * (2 = SEGV_ACCERR) and must not be reported as the signal.
 * Older payloads may use `{ signal, name }` instead of `signo`.
 */
export function describeFaultSignal(signal: SignalValue): string {
  if (signal === undefined || signal === null) {
    return '';
  }
  if (typeof signal !== 'object') {
    return String(signal);
  }
  const record = signal as Record<string, SignalValue>;
  const name = signalLabel(record['name'] ?? record['signal_name']);
  const signo = firstSignalNumber(record['signo'], record['signal'], record['number']);
  const parts: string[] = [];
  if (name.length > 0) {
    parts.push(name);
  }
  if (signo !== null && String(signo) !== name) {
    parts.push(String(signo));
  }
  let text = parts.join(' ');
  if (signo !== null) {
    const siCode = finiteSignalNumber(record['code']);
    if (siCode !== null) {
      text = text.length > 0 ? `${text}, code ${siCode}` : `code ${siCode}`;
    }
  }
  return text;
}

/**
 * `Version` / `VersionCode` are the crashed process header. In-process logs
 * use `Version name` / `Version code`. `bundle_version` and a `Bundle version`
 * line are only a version-name fallback. No match means the build is unknown,
 * not that the uploading install should be used.
 */
export function faultBuildIdentity(
  bundleVersion: SignalValue,
  faultText: string,
): FaultBuildIdentity | null {
  const headerName = labeledLine(faultText, /^Version:\s*(\S.*?)\s*$/m);
  const reportedName = labeledLine(faultText, /^Version name:\s*(\S.*?)\s*$/m);
  const bundleLine = labeledLine(faultText, /^Bundle version:\s*(\S.*?)\s*$/m);
  const headerCode = labeledCode(faultText, /^VersionCode:\s*(\d+)\s*$/m);
  const reportedCode = labeledCode(faultText, /^Version code:\s*(\d+)\s*$/m);
  const paramName = typeof bundleVersion === 'string' ? bundleVersion.trim() : '';
  const versionName = headerName || reportedName || bundleLine || paramName;
  const versionCode = headerCode ?? reportedCode;
  if (versionName.length === 0 && versionCode === null) {
    return null;
  }
  return {
    versionName,
    versionCode,
  };
}

/**
 * Crash upload identity. A stored key, including an empty name or a null code,
 * is explicit. An older sidecar with neither key is recovered from its log.
 * Neither case may borrow the install that uploads the ticket.
 */
export function historicalCrashBuild(
  stored: StoredCrashBuild,
  keys: StoredCrashBuildKeys,
  logText: string,
): HandsCapturedBuild {
  const recorded = capturedCrashBuild(stored, keys);
  if (recorded !== null) {
    return recorded;
  }
  const fromLog = faultBuildIdentity('', logText);
  if (fromLog !== null) {
    return {
      versionName: fromLog.versionName,
      versionCode: fromLog.versionCode,
    };
  }
  return { versionName: '', versionCode: null };
}

/** A sidecar that recorded a build is a capture. Missing keys are not a build. */
export function capturedCrashBuild(
  stored: StoredCrashBuild,
  keys: StoredCrashBuildKeys,
): HandsCapturedBuild | null {
  if (!keys.versionName && !keys.versionCode) {
    return null;
  }
  return {
    versionName: keys.versionName ? stored.versionName : '',
    versionCode: keys.versionCode ? stored.versionCode : null,
  };
}

/**
 * Once a crash recorded its own build, do not fill gaps from the process
 * that uploads it. A missing version code stays missing so symbolication
 * cannot attach the wrong build.
 */
export function crashTicketVersions(
  captured: HandsCapturedBuild | null,
  live: { versionName: string; versionCode: number },
): TicketBuildFields {
  if (captured === null) {
    return {
      versionName: live.versionName,
      versionCode: live.versionCode,
    };
  }
  const name = (captured.versionName ?? '').trim();
  const code = typeof captured.versionCode === 'number' && Number.isSafeInteger(captured.versionCode)
    ? captured.versionCode
    : null;
  return {
    versionName: name.length > 0 ? name : null,
    versionCode: code,
  };
}

function labeledLine(text: string, pattern: RegExp): string {
  return text.match(pattern)?.[1]?.trim() ?? '';
}

function labeledCode(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  return match ? finiteSignalNumber(match[1]) : null;
}

function signalLabel(value: SignalValue): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function firstSignalNumber(...values: SignalValue[]): number | null {
  for (const value of values) {
    const parsed = finiteSignalNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function finiteSignalNumber(value: SignalValue): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
