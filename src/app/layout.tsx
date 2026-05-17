import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "../components/Providers";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Darwin Protocol — Confidential baskets, native to Miden",
  description:
    "Client-side STARK-proven basket protocol. Pragma price feeds, AggLayer access from any EVM wallet. The portfolio is yours — and only yours.",
  metadataBase: new URL("https://darwin.xyz"),
  openGraph: {
    title: "Darwin Protocol",
    description: "Confidential baskets, native to Miden.",
    url: "https://darwin.xyz",
    siteName: "Darwin Protocol",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
