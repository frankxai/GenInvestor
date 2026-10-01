import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "GenInvestor · Evidence workspace",
  description: "Local research with a receipt behind every figure.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
