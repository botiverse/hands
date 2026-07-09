import {
  HandsLogger,
  defaultLogDirectory,
  type LogFields,
  type LogLevel,
} from "@botiverse/hands-node";

let cliLogger: HandsLogger | undefined;

export function getCliLogger(): HandsLogger {
  if (!cliLogger) {
    cliLogger = new HandsLogger({
      name: "cli",
      dir: process.env.HANDS_LOG_DIR ?? defaultLogDirectory("hands"),
      minLevel: process.env.HANDS_VERBOSE === "1" ? "debug" : "info",
      thread: "cli",
    });
  }
  return cliLogger;
}

export function tryGetCliLogger(): HandsLogger | undefined {
  try {
    return getCliLogger();
  } catch {
    return undefined;
  }
}

export function recordCliEvent(
  level: LogLevel,
  event: string,
  message: string,
  fields?: LogFields,
): void {
  tryGetCliLogger()?.write(level, "cli", message, fields, event);
}

export function resetCliLoggerForTests(): void {
  cliLogger = undefined;
}
