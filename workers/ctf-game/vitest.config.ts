import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const testSecret = "test-only-session-secret-not-for-production-2026";
process.env.SESSION_SECRET = testSecret;

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        SESSION_SECRET: testSecret,
      },
    },
  })],
  test: { include: ["test/**/*.test.ts", "test/labs.test.js"], fileParallelism: false },
});
