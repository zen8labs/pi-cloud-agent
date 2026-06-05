"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Sessions", icon: SessionsIcon, match: (p: string) => p === "/" || p.startsWith("/sessions") },
  { href: "/chat", label: "New session", icon: ChatIcon, match: (p: string) => p.startsWith("/chat") },
];

export function SideNav() {
  const pathname = usePathname();
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-ink)] text-[13px] font-semibold text-white">
          C
        </div>
        <div className="text-sm font-semibold tracking-tight">CoReview</div>
      </div>

      <nav className="flex flex-col gap-0.5 px-3">
        {links.map((l) => {
          const active = l.match(pathname);
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                active
                  ? "bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]"
                  : "text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink)]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {l.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto px-5 py-4 text-[11px] leading-relaxed text-[var(--color-faint)]">
        Cloud agent dashboard
        <br />
        No auth · debug mode
      </div>
    </aside>
  );
}

function SessionsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <rect x="2" y="10" width="12" height="3" rx="1" />
    </svg>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
    </svg>
  );
}
