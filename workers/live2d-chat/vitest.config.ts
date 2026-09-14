import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        DEEPSEEK_API_KEY: "test-only-deepseek-key",
        IP_HASH_SECRET: "test-only-hmac-secret-never-use-in-production",
      },
    },
  })],
  test: { include: ["test/**/*.test.ts"] },
});
