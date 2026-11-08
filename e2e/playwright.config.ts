// E2E 基盤。
// 実スタック（wrangler dev + next dev + ローカル D1）を webServer で起動する。
// ポート・状態ディレクトリは WP7 専用（WORKPACKAGES §1 / CONTRACTS §8）:
//   web 3107 / api 8807 / 外部サービススタブ 8898 / D1 persist .wrangler/state-e2e
// 起動前に migrations apply + seed を実行する（scripts/start-api.sh）。
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3107);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8807);
const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 8898);

// Next dev の HMR は localhost を前提にするため、baseURL も localhost に揃える
// （API の ALLOWED_ORIGINS には start-api.sh が localhost と 127.0.0.1 の両方を渡す）。
const WEB_URL = `http://localhost:${WEB_PORT}`;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;

// helpers は env 経由で接続先を知る（config と spec の二重管理を避ける）。
process.env.E2E_WEB_URL ??= WEB_URL;
process.env.E2E_API_URL ??= API_URL;
process.env.E2E_STUB_URL ??= STUB_URL;
process.env.E2E_ALLOWED_ORIGIN ??= WEB_URL;

const isCI = Boolean(process.env.CI);

// 同じ作業ツリーで複数の Playwright 実行（別の E2E）が同時に走ると、
// 既定の `test-results` / `playwright-report` を共有して trace が消え合う。
// 並行実行時は E2E_OUTPUT_DIR / E2E_REPORT_DIR を分ける（CI は既定のまま）。
const outputDir = process.env.E2E_OUTPUT_DIR ?? "test-results";
const reportDir = process.env.E2E_REPORT_DIR ?? "playwright-report";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: isCI
    ? [["github"], ["html", { open: "never", outputFolder: reportDir }]]
    : [["list"], ["html", { open: "never", outputFolder: reportDir }]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // モバイルは Chromium ベース（WebKit の追加インストールを CI で要求しない）。
    { name: "pc", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "bash scripts/start-api.sh",
      url: `${API_URL}/v1/health`,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        E2E_API_PORT: String(API_PORT),
        E2E_PERSIST_DIR: process.env.E2E_PERSIST_DIR ?? path.join(repoRoot, ".wrangler", "state-e2e"),
        E2E_ALLOWED_ORIGINS: `${WEB_URL},http://127.0.0.1:${WEB_PORT}`,
        // 読み取り系 IP ウィンドウの緩和（本番既定は不変・start-api.sh が --var で 10 倍を渡す）。
        E2E_RATE_LIMIT_RELAX: process.env.E2E_RATE_LIMIT_RELAX ?? "1",
      },
    },
    {
      command: "bash scripts/start-web.sh",
      url: WEB_URL,
      reuseExistingServer: !isCI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        E2E_WEB_PORT: String(WEB_PORT),
        API_ORIGIN: API_URL,
      },
    },
    {
      command: "node scripts/stub-server.mjs",
      url: `${STUB_URL}/__health`,
      reuseExistingServer: !isCI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, E2E_STUB_PORT: String(STUB_PORT) },
    },
  ],
});
