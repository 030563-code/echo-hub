import type { Metadata, Viewport } from "next";
import { Varela_Round, Roboto } from "next/font/google";
import { RegisterServiceWorker } from "@/components/pwa/register-service-worker";
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
  applicationName: "Echo Barrier Hub",
  manifest: "/manifest.webmanifest",
  // What iOS uses when the Hub is added to a home screen: its own window, and
  // the short name under the icon.
  appleWebApp: { capable: true, title: "Echo Hub", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  // The window chrome around the installed app, and the Android status bar.
  themeColor: "#FF7026",
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
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
