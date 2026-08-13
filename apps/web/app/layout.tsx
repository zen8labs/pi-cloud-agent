import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { ThemeProvider } from "@/components/ThemeProvider";
import { cn } from "@/lib/utils";
import "./globals.css";

export const metadata: Metadata = {
  title: "zen8agent",
  description: "Start, steer, and inspect Pi agent sessions",
  icons: {
    icon: [{ url: "/assets/z8l-logo.png", type: "image/png" }],
    apple: "/assets/z8l-logo.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(GeistSans.variable, GeistMono.variable)}
    >
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: fixed theme bootstrap, no user input
          dangerouslySetInnerHTML={{
            // biome-ignore lint/style/useNamingConvention: React owns this key
            __html: `try{var t=localStorage.getItem('pca-theme')||'light';var r=document.documentElement;r.setAttribute('data-theme',t);r.classList.toggle('dark',t==='dark')}catch(e){}`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
