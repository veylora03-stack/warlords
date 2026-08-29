import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "WARLORDS — Telegram MMO Strategy",
  description:
    "WARLORDS: a persistent, server-authoritative MMO strategy game for Telegram. Build your city, raise armies, and conquer territories.",
  keywords: ["WARLORDS", "Telegram", "MMO", "strategy", "game", "Next.js"],
  authors: [{ name: "WARLORDS Team" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "WARLORDS — Telegram MMO Strategy",
    description: "Build. Conquer. Rule. A persistent strategy world inside Telegram.",
    siteName: "WARLORDS",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
