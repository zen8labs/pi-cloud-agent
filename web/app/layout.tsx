import type { Metadata } from "next";
import "./globals.css";
import { SideNav } from "@/components/SideNav";

export const metadata: Metadata = {
  title: "CoReview Agent",
  description: "Monitor and drive the cloud agent",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <div className="flex min-h-screen">
          <SideNav />
          <main className="flex-1 overflow-hidden">{children}</main>
        </div>
      </body>
    </html>
  );
}
