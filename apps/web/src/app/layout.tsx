// サイト共通レイアウト。静的なシェル HTML（SEO/OGP はビルド時テンプレート + クライアント差し替え）。
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/ui";

export const metadata: Metadata = {
  title: {
    default: "おーぷんクローン",
    template: "%s ｜ おーぷんクローン",
  },
  description: "AI運営型・匿名掲示板。板もスレもレスも、ユーザーの手で。",
  applicationName: "おーぷんクローン",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "おーぷんクローン",
    description: "AI運営型・匿名掲示板。板もスレもレスも、ユーザーの手で。",
    type: "website",
    siteName: "おーぷんクローン",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ccffcc",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}