import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const sans = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  // Needed for the og:image URL to be absolute. Vercel sets VERCEL_URL per
  // deployment; the localhost fallback keeps dev and the build working.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"),
  ),
  title: "Who Printed — the wallets that made money on this contract",
  description:
    "Paste a contract address, see the 100 wallets that printed on it, and export them straight into Axiom, Terminal or Photon. Solana, BNB Chain and Base, powered by Dune.",
  // opengraph-image.png / twitter-image.png next to this file supply the image;
  // Next emits the tags and hashes the URL for cache busting.
  openGraph: {
    type: "website",
    title: "Who Printed — who made money on this contract",
    description:
      "Paste a contract address. The 100 wallets that printed on it, with the market cap each one entered and exited at.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Who Printed — who made money on this contract",
    description:
      "Paste a contract address. The 100 wallets that printed on it, with the market cap each one entered and exited at.",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
