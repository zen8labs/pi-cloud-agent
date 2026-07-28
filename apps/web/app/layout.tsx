import type { Metadata } from "next";
import "./globals.css";
import { SideNav } from "@/components/SideNav";
import { ThemeProvider } from "@/components/ThemeProvider";

export const metadata: Metadata = {
  title: "Pi Cloud Agent",
  description: "Watch cloud agent runs and start new ones",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap"
          rel="stylesheet"
        />
        {/*
          Applies the saved theme before the first paint, which avoids a flash of
          the wrong theme during hydration. The content is a fixed literal with no
          interpolation, so there is no injection surface.
        */}
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static literal, no user input
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('pca-theme');if(t==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>
          <div className="flex min-h-screen">
            <SideNav />
            <main className="flex-1 overflow-hidden">{children}</main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
