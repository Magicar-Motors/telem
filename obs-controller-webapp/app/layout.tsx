import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./compact.css";

export const metadata: Metadata = {
  title: "Scene Deck · OBS remote",
  description: "Your horizontal and vertical OBS scenes, within reach.",
  appleWebApp: {
    capable: true,
    title: "Scene Deck",
    statusBarStyle: "black-translucent",
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#101313",
  viewportFit: "cover",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
