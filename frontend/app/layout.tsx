import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Shell from "@/components/Shell";
import PwaProvider from "@/components/pwa/PwaProvider";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "MedForecast AI — Seasonal medicine demand",
  description: "Seasonal demand forecasting and stock planning for a Kerala pharmacy.",
  applicationName: "MedForecast AI",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "MedForecast", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0e5c4f",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="font-sans antialiased">
        <PwaProvider>
          <Shell>{children}</Shell>
        </PwaProvider>
      </body>
    </html>
  );
}
