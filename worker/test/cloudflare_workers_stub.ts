// Node-only test substitute for the Workers RPC base class. Production builds
// continue to resolve the native `cloudflare:workers` module.
export class WorkerEntrypoint<Environment> {
  env: Environment;
  constructor(context: { env: Environment }) {
    this.env = context.env;
  }
}
