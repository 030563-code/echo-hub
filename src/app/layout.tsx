import type { Metadata } from "next";
import { Varela_Round, Roboto } from "next/font/google";
import "./globals.css";

const varelaRound = Varela_Round({
  weight: "400",
  variable: "--font-varela-round",
  subsets: ["latin"],
});

const roboto = Roboto({
  weight: ["300", "400", "500", "700"],
  variable: "--font-roboto",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Echo Barrier Hub",
  description: "Echo Barrier's unified internal operating platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${varelaRound.variable} ${roboto.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
