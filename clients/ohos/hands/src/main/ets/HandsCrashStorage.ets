import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import fs from '@ohos.file.fs';
import util from '@ohos.util';
import {
  crashLogFileName,
  ensureCrashDirectory,
} from './HandsCrashStoragePolicy';

const FILE_EXISTS_ERROR_CODE: number = 13900015;

/** Shared, fail-closed storage boundary for ArkTS and system fault captures. */
export class HandsCrashStorage {
  static crashDir(context: common.UIAbilityContext): string {
    return `${context.filesDir}/crashes`;
  }

  static writeLog(
    context: common.UIAbilityContext,
    crashLog: string,
    label: string = '',
    timestampMillis: number = Date.now(),
  ): string {
    const crashDir = HandsCrashStorage.crashDir(context);
    HandsCrashStorage.ensureDirectory(crashDir);
    const crashPath = `${crashDir}/${crashLogFileName(
      timestampMillis,
      util.generateRandomUUID(true),
      label,
    )}`;
    const file = fs.openSync(
      crashPath,
      fs.OpenMode.CREATE | fs.OpenMode.TRUNC | fs.OpenMode.WRITE_ONLY,
    );
    try {
      fs.writeSync(file.fd, crashLog);
    } finally {
      fs.closeSync(file);
    }
    return crashPath;
  }

  private static ensureDirectory(path: string): void {
    ensureCrashDirectory(
      (): boolean => HandsCrashStorage.pathIsDirectory(path),
      (): void => fs.mkdirSync(path, true),
      (error: Object): boolean => (error as BusinessError).code === FILE_EXISTS_ERROR_CODE,
    );
  }

  private static pathIsDirectory(path: string): boolean {
    try {
      const stat = fs.lstatSync(path);
      return !stat.isSymbolicLink() && stat.isDirectory();
    } catch (_error) {
      return false;
    }
  }
}
