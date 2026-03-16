import type { Metadata } from "next";
import { Syne, Space_Grotesk, Instrument_Serif } from "next/font/google";
import "./globals.css";

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Pulse — AI-Powered Live Radio",
  description:
    "24/7 AI radio covering AI, startups, and tech. Live news, real-time analysis, and listener call-ins powered by Gemini.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__PULSE_API_URL=${JSON.stringify(apiUrl)};`,
          }}
        />
      </head>
      <body
        className={`${syne.variable} ${spaceGrotesk.variable} ${instrumentSerif.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
