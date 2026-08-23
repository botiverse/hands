import type { Command } from "commander";
import { getDeviceId } from "@botiverse/hands-node";

export function registerDeviceIdCommand(program: Command): void {
  program.command("device-id")
    .description("Print the local Hands device ID (OS-user scope).")
    .option("--json", "Output machine-readable JSON.", false)
    .action(async (opts: { json?: boolean }) => {
      const id = await getDeviceId();
      if (opts.json) console.log(JSON.stringify({ device: { id, scope: "os_user", namespace: "hands.build" } }, null, 2));
      else { console.log(`device_id: ${id}`); console.log("device_scope: os_user"); console.log("device_namespace: hands.build"); }
    });
}
