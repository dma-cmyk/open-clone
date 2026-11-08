// トップ（シェル）。静的エクスポートの index.html が全 URL の受け皿になる。
import { AppShell } from "./_shell/app-shell";

export default function Page() {
  return <AppShell />;
}