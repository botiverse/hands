// Restrict unquoted values to characters that do not invoke shell expansion or
// argument separators in POSIX shells, PowerShell, and Windows cmd.exe. Also
// exclude leading '-' so a value cannot be mistaken for an option.
const PORTABLE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type RecoveryField = "appId" | "buildId" | "submissionId" | "distribution" | "bundleId";
type RecoveryOption = "--build" | "--distribution" | "--bundle-id" | "--";
export type RecoveryPart = RecoveryOption | { field: RecoveryField; value: string };

// JSON-escape every non-portable character, including terminal controls and
// Unicode formatting characters. JSON.parse still recovers the exact value.
function safeJsonString(value: string): string {
  let output = '"';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    output += /^[A-Za-z0-9._-]$/.test(char)
      ? char
      : `\\u${value.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return `${output}"`;
}

/** Do not suggest an executable shell command containing unsafe dynamic data. */
export function recoveryGuidance(
  command: "agc status" | "builds testflight-status",
  parts: readonly RecoveryPart[],
): string {
  const values = parts.filter((part): part is Exclude<RecoveryPart, string> => typeof part !== "string");
  if (values.every(({ value }) => PORTABLE_VALUE.test(value))) {
    return ["hands", command, ...parts.map((part) => typeof part === "string" ? part : part.value)].join(" ");
  }
  const template = ["hands", command, ...parts.map((part) => typeof part === "string" ? part : `{${part.field}}`)].join(" ");
  const data = `{${values.map(({ field, value }) => `${safeJsonString(field)}:${safeJsonString(value)}`).join(",")}}`;
  return `the status lookup (template only, not an executable command: ${template}; the following JSON strings are data, not shell syntax: decode and quote the values for your shell): ${data}`;
}
