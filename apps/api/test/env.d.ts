// cloudflare:test の env をアプリの Env に接続する型拡張。
// Cloudflare.Env 名前空間を augment して、D1 バインディング等をテストで型安全に使えるようにする。
import type { Env as AppEnvBindings } from "../src/lib/env";
import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnvBindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

