import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          ID_SALT: "test-salt",
          ENC_KEY: "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=",
          OWNER_BOOTSTRAP_KEY: "test-owner-key",
          TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
          ALLOWED_ORIGINS: "http://localhost:3000",
          ENVIRONMENT: "development",
          // --- WP4（アップローダ / GitHub）テスト用のダミー値。実秘密は置かない ---
          GITHUB_CLIENT_ID: "test-github-client-id",
          GITHUB_CLIENT_SECRET: "test-github-client-secret",
          GITHUB_WEBHOOK_SECRET: "test-github-webhook-secret",
          CLOUDINARY_CLOUD_NAME: "test-cloud",
          CLOUDINARY_API_KEY: "test-api-key",
          CLOUDINARY_API_SECRET: "test-api-secret",
          // プラグイン AI 連携（接続先はテストごとに site_config へ設定する）
          PLUGIN_AI_API_KEY: "test-plugin-ai-key",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts", "./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
