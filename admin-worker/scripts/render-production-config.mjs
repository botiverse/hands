import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outputIndex = process.argv.indexOf("--output");
const output = resolve(root, outputIndex >= 0 ? process.argv[outputIndex + 1] : "wrangler.generated.jsonc");
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment value ${name}`);
  return value;
};
const uuid = (name) => {
  const value = required(name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
};
const domain = (name) => {
  const value = required(name).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value)) throw new Error(`${name} must be a hostname`);
  return value;
};

const config = parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
config.name = required("HANDS_ADMIN_WORKER_NAME");
config.routes = [{ pattern: domain("HANDS_ADMIN_DOMAIN"), custom_domain: true }];
config.services[0].service = required("HANDS_WORKER_NAME");
config.d1_databases[0].database_name = required("HANDS_ADMIN_AUDIT_DB_NAME");
config.d1_databases[0].database_id = uuid("HANDS_ADMIN_AUDIT_DB_ID");
config.vars = {
  RAFT_ORIGIN: required("HANDS_RAFT_ORIGIN"),
  RAFT_API_ORIGIN: required("HANDS_RAFT_API_ORIGIN"),
  RAFT_CLIENT_ID: required("HANDS_ADMIN_RAFT_CLIENT_ID"),
  RAFT_ALLOWED_SERVER_IDS: required("HANDS_ADMIN_ALLOWED_SERVER_IDS"),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Rendered production Wrangler config: ${output}`);
