import { defineConfig } from "vitest/config";

// Default suite: mock only, no network. The live sandbox suite has its own config.
export default defineConfig({
  test: { include: ["tests/*.test.ts"] },
});
