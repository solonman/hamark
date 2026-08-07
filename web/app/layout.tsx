import type { Metadata } from "next";
import { headers } from "next/headers";
import GlobalHomeButton from "./components/GlobalHomeButton";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ||
    requestHeaders.get("host") ||
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", baseUrl).toString();

  return {
    metadataBase: baseUrl,
    title: {
      default: "RE:VERSE 反写",
      template: "%s · RE:VERSE 反写",
    },
    description: "把优秀影像重新拆开——团队视频创意逆向学习与标注平台。",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "RE:VERSE 反写",
      description: "把优秀影像重新拆开。",
      type: "website",
      images: [{ url: socialImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "RE:VERSE 反写",
      description: "把优秀影像重新拆开。",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <GlobalHomeButton />
        {children}
      </body>
    </html>
  );
}
