"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "@/components/ThemeProvider";

const links = [
  { href: "/", label: "Sessions", icon: SessionsIcon, match: (p: string) => p === "/" || p.startsWith("/sessions") },
  { href: "/chat", label: "New Session", icon: PlusIcon, match: (p: string) => p.startsWith("/chat") },
  { href: "/settings", label: "Settings", icon: SettingsIcon, match: (p: string) => p.startsWith("/settings") },
];

export function SideNav() {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();
  // Defer theme-specific content until after hydration to avoid mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <aside
      className="flex w-[200px] shrink-0 flex-col border-r"
      style={{ borderColor: "var(--color-line-strong)", background: "var(--color-surface)" }}
    >
      {/* Logo */}
      <div
        className="flex items-center gap-2.5 border-b px-4 py-4"
        style={{ borderColor: "var(--color-line)" }}
      >
        <div
          className="flex h-6 w-6 items-center justify-center text-[11px] font-bold"
          style={{ background: "var(--color-accent)", color: "#fff" }}
        >
          CR
        </div>
        <span
          className="font-mono text-[13px] font-semibold tracking-tight"
          style={{ color: "var(--color-ink)" }}
        >
          COREVIEW
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col gap-px p-2 pt-3">
        <p
          className="mb-1 px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em]"
          style={{ color: "var(--color-faint)" }}
        >
          Workspace
        </p>
        {links.map((l) => {
          const active = l.match(pathname);
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              className="group flex items-center gap-2.5 border-l-2 py-2 pl-1.5 pr-2 text-[13px] font-medium transition-colors"
              style={{
                borderColor: active ? "var(--color-accent)" : "transparent",
                background: active ? "var(--color-surface-2)" : "transparent",
                color: active ? "var(--color-ink)" : "var(--color-muted)",
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLElement).style.background = "var(--color-surface-2)";
                  (e.currentTarget as HTMLElement).style.color = "var(--color-ink)";
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                  (e.currentTarget as HTMLElement).style.color = "var(--color-muted)";
                }
              }}
            >
              <Icon
                className="h-3.5 w-3.5 shrink-0"
                style={{ color: active ? "var(--color-accent)" : "var(--color-faint)" }}
              />
              {l.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div
        className="mt-auto border-t px-4 py-3"
        style={{ borderColor: "var(--color-line)" }}
      >
        {/* Theme toggle — content deferred until mounted to avoid hydration mismatch */}
        <button
          onClick={toggle}
          className="mb-3 flex w-full items-center justify-between border px-3 py-2 transition-colors"
          style={{
            borderColor: "var(--color-line-strong)",
            background: "var(--color-surface-2)",
            color: "var(--color-muted)",
          }}
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.08em]">
            {mounted ? (theme === "light" ? "Light" : "Dark") : ""}
          </span>
          {mounted ? (theme === "light" ? <SunIcon /> : <MoonIcon />) : null}
        </button>

        <p className="font-mono text-[10px] uppercase tracking-[0.08em]" style={{ color: "var(--color-faint)" }}>
          Cloud Agent
        </p>
        <p className="mt-0.5 font-mono text-[10px]" style={{ color: "var(--color-faint)" }}>
          debug · no auth
        </p>
      </div>
    </aside>
  );
}

function SessionsIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2.5" width="12" height="3.5" rx="0.5" />
      <rect x="2" y="10" width="12" height="3.5" rx="0.5" />
    </svg>
  );
}

function PlusIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function SettingsIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2 4.5h7M11.5 4.5h2.5M2 11.5h2.5M7 11.5h7" />
      <circle cx="10" cy="4.5" r="1.6" />
      <circle cx="5.5" cy="11.5" r="1.6" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M11.5 3.5l-1 1M3.5 11.5l-1 1" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 10A6 6 0 016 2.5a6 6 0 100 11 6 6 0 007.5-3.5z" />
    </svg>
  );
}
