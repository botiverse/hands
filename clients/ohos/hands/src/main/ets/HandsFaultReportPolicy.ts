/**
 * Pure decisions for OHOS crash tickets. hiAppEvent delivers native crashes
 * on the next launch, which may already be a different install. These helpers
 * keep the signal number and the crashed build identity off that later process.
 */

export interface HandsCapturedBuild {
  versionName?: string;
  versionCode?: number | null;
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
 * `Version` / `VersionCode` are the crashed process header. `bundle_version`
 * is only a version-name fallback when that header is missing.
 */
export function faultBuildIdentity(
  bundleVersion: SignalValue,
  faultText: string,
): FaultBuildIdentity | null {
  const versionMatch = faultText.match(/^Version:\s*(\S.*?)\s*$/m);
  const codeMatch = faultText.match(/^VersionCode:\s*(\d+)\s*$/m);
  const logName = versionMatch?.[1]?.trim() ?? '';
  const logCode = codeMatch ? finiteSignalNumber(codeMatch[1]) : null;
  const paramName = typeof bundleVersion === 'string' ? bundleVersion.trim() : '';
  const versionName = logName || paramName;
  if (versionName.length === 0 && logCode === null) {
    return null;
  }
  return {
    versionName,
    versionCode: logCode,
  };
}

/** A sidecar that recorded a build is a capture. Missing keys stay on the live install. */
export function capturedCrashBuild(
  stored: { versionName: string; versionCode: number | null },
  keys: { versionName: boolean; versionCode: boolean },
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
