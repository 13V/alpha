import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bagtrace — who actually made money on this contract",
  description:
    "Paste a contract address and trace the wallets behind it: realized PnL, entry and exit market caps, current bags. Solana, BNB Chain and Base, powered by Dune.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
