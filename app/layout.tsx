import type { Metadata, Viewport } from "next";
import "./globals.css";
import { DeviceRealtimeProvider } from "@/lib/realtime/DeviceRealtimeContext";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://u-l-t-r-o-n-e.vercel.app"),
  title: "ULTRON — Autonomous Personal AI Companion",
  description: "Autonomous personal AI companion featuring futuristic titanium robotic neural intelligence, real-time multimodal interaction, and secure Android hardware link.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [
      { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  openGraph: {
    title: "ULTRON — Autonomous Personal AI Companion",
    description: "Autonomous personal AI companion featuring futuristic titanium robotic neural intelligence, real-time multimodal interaction, and secure Android hardware link.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "ULTRON Autonomous Personal AI Companion",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ULTRON — Autonomous Personal AI Companion",
    description: "Autonomous personal AI companion featuring futuristic titanium robotic neural intelligence.",
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <DeviceRealtimeProvider>{children}</DeviceRealtimeProvider>
      </body>
    </html>
  );
}
