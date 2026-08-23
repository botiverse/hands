import type { Command } from "commander";
import { getHandsDeviceId } from "@botiverse/hands-node";
export const deviceJson = (id: string) => ({ device: { id, scope: "os_user", namespace: "hands.build" } });
export const deviceText = (id: string) => `device_id: ${id}\ndevice_scope: os_user\ndevice_namespace: hands.build`;

export function jsonRequested(command: Command, opts: { json?: boolean }): boolean {
  return Boolean(opts.json || command.optsWithGlobals<{ json?: boolean }>().json);
}

export function registerDeviceIdCommand(program: Command): void {
  program.command("device-id")
    .description("Print the local Hands device ID (OS-user scope).")
    .option("--json", "Output machine-readable JSON.", false)
    .action(async (opts: { json?: boolean }, command: Command) => {
      const id = await getHandsDeviceId();
      if (jsonRequested(command, opts)) console.log(JSON.stringify(deviceJson(id), null, 2));
      else console.log(deviceText(id));
    });
}
