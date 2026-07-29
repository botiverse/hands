/** Runtime/package version reported with OHOS feedback and crash tickets. */
export const HANDS_OHOS_SDK_VERSION: string = '0.3.3';

/**
 * Creates a directory exactly once without treating an already-created
 * directory as a failure. The caller supplies the platform file operations so
 * this policy stays executable in host-side contract tests.
 */
export function ensureCrashDirectory(
  isDirectory: () => boolean,
  createDirectory: () => void,
  isFileExistsError: (error: Object) => boolean,
): void {
  if (isDirectory()) {
    return;
  }
  try {
    createDirectory();
  } catch (error) {
    if (isFileExistsError(error as Object) && isDirectory()) {
      return;
    }
    throw error;
  }
}

/** Build a collision-resistant crash filename from a fixed timestamp and id. */
export function crashLogFileName(
  timestampMillis: number,
  uniqueId: string,
  label: string = '',
): string {
  if (uniqueId.length === 0) {
    throw new Error('Crash log unique id must not be empty');
  }
  const timestamp = new Date(timestampMillis).toISOString().replace(/[:.]/g, '-');
  const labelSuffix = label.length > 0 ? `-${label}` : '';
  return `crash-${timestamp}-${uniqueId}${labelSuffix}.txt`;
}

/** Return only the oldest crash logs that exceed the bounded retention cap. */
export function crashLogsBeyondRetention(logNames: string[], maxStoredCrashes: number): string[] {
  if (maxStoredCrashes < 0) {
    throw new Error('Crash retention cap must not be negative');
  }
  return logNames.slice().sort().reverse().slice(maxStoredCrashes);
}

/** Run one capture without letting its failure abort later events in a batch. */
export function runIsolatedCrashCapture(
  capture: () => void,
  onFailure: (error: Object) => void,
): boolean {
  try {
    capture();
    return true;
  } catch (error) {
    onFailure(error as Object);
    return false;
  }
}

/** Delete a pending crash pair only after the ticket upload has succeeded. */
export async function uploadCrashThenDelete(
  upload: () => Promise<string>,
  deletePending: () => void,
): Promise<string> {
  const ticketId = await upload();
  deletePending();
  return ticketId;
}
