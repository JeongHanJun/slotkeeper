import { defineConfig } from "vitest/config";
import { loadSandboxEnv, sandboxReady } from "./scripts/lib.mjs";

// `npm run test:sandbox`: talks to api-m.sandbox.paypal.com with the keys in
// .dev.vars. Skips itself unless PAYPAL_MODE=sandbox and both keys are there.
const env = loadSandboxEnv();
const ready = sandboxReady(env);

export default defineConfig({
  test: {
    include: ["tests/sandbox/*.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
    provide: {
      sandbox: {
        ready,
        clientId: ready ? env.PAYPAL_CLIENT_ID : "",
        clientSecret: ready ? env.PAYPAL_CLIENT_SECRET : "",
      },
    },
  },
});
