import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Alpha Wallets — top wallets for any contract",
  description:
    "Paste a contract address, get the wallets that made the most money on it. Solana, BNB Chain and Base, powered by Dune.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
