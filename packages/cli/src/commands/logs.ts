import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import {
  collectLogs,
  defaultCollectionStateFile,
  type CollectionNetwork,
} from "@botiverse/hands-node";
import type { SignedCollectPolicy } from "@botiverse/hands-node/logs/schema";
import { tryGetCliLogger } from "../lib/logging.js";

interface CollectOptions {
  policy: string;
  publicKey: string;
  output?: string;
  network?: string;
  json?: boolean;
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function registerLogsCommands(program: Command): void {
  const logs = program.command("logs").description("Inspect and collect local Hands logs.");

  logs
    .command("collect")
    .description("Create a redacted local log bundle against a signed collect policy.")
    .requiredOption("--policy <path>", "Signed collect-policy JSON file.")
    .requiredOption("--public-key <path>", "Ed25519 public key in PEM format.")
    .option("--output <path>", "Output .json.gz bundle path.")
    .option("--network <quality>", "Network quality: strong, weak, or offline.", "strong")
    .option("--json", "Output machine-readable JSON.", false)
    .action((opts: CollectOptions, command: Command) => {
      const logger = tryGetCliLogger();
      if (!logger) {
        const result = {
          ok: false as const,
          code: "LOG_DIRECTORY_UNAVAILABLE",
          message: "the Hands log directory is unavailable",
        };
        if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
          console.log(JSON.stringify(result));
        } else {
          console.error(`Hands log collection skipped: ${result.message}`);
          console.error(`Code: ${result.code}`);
        }
        return;
      }
      const output = resolve(opts.output ?? `hands-logs-${timestampForFile()}.json.gz`);
      let policy: SignedCollectPolicy;
      try {
        policy = JSON.parse(readFileSync(resolve(opts.policy), "utf8")) as SignedCollectPolicy;
      } catch (cause) {
        const result = {
          ok: false as const,
          code: "POLICY_READ_FAILED",
          message: cause instanceof Error ? cause.message : String(cause),
        };
        if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
          console.log(JSON.stringify(result));
        } else {
          console.error(`Hands log collection skipped: ${result.message}`);
          console.error(`Code: ${result.code}`);
        }
        return;
      }
      const network = opts.network as CollectionNetwork;
      if (!(["strong", "weak", "offline"] as const).includes(network)) {
        const result = {
          ok: false as const,
          code: "NETWORK_QUALITY_INVALID",
          message: "network must be strong, weak, or offline",
        };
        if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
          console.log(JSON.stringify(result));
        } else {
          console.error(`Hands log collection skipped: ${result.message}`);
          console.error(`Code: ${result.code}`);
        }
        return;
      }
      let publicKey: string;
      try {
        publicKey = readFileSync(resolve(opts.publicKey), "utf8");
      } catch (cause) {
        const result = {
          ok: false as const,
          code: "PUBLIC_KEY_READ_FAILED",
          message: cause instanceof Error ? cause.message : String(cause),
        };
        if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
          console.log(JSON.stringify(result));
        } else {
          console.error(`Hands log collection skipped: ${result.message}`);
          console.error(`Code: ${result.code}`);
        }
        return;
      }

      const result = collectLogs({
        policy,
        publicKeys: {
          [policy?.payload?.key_id ?? "unknown"]: publicKey,
        },
        files: logger.currentFiles(),
        outputFile: output,
        stateFile: defaultCollectionStateFile(logger.options.dir),
        source: "hands-cli",
        network,
        auditLogger: logger,
      });
      if (opts.json || command.optsWithGlobals<{ json?: boolean }>().json) {
        console.log(JSON.stringify(result));
        return;
      }
      if (!result.ok) {
        console.error(`Hands log collection skipped: ${result.message}`);
        console.error(`Code: ${result.code}`);
        return;
      }
      console.log(`Created ${result.output_file}`);
      console.log(
        `Collected ${result.bundle.manifest.entries_count} entries (${result.bundle.manifest.uncompressed_bytes} bytes, ${result.compressed_bytes} compressed).`,
      );
    });
}
