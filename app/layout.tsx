import type { Metadata, Viewport } from "next";
import "./globals.css";
import { DeviceRealtimeProvider } from "@/lib/realtime/DeviceRealtimeContext";

export const metadata: Metadata = {
  title: "U.L.T.R.O.N. — Neural AI Core",
  description: "An Iron Man-inspired holographic AI companion and neural orb interface",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [
      { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
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
