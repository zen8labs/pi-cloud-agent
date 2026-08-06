"use client";

import type { AppUserSummary } from "@pi-cloud-agent/protocol";
import { LogOutIcon, MoonIcon, Settings2Icon, SunIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ThemeProvider";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function AccountMenu({ compact = false, placement = "top" }: AccountMenuProps) {
  const [user, setUser] = useState<AppUserSummary | null>(null);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    void api
      .getCurrentUser()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node))
        setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const logout = async () => {
    await api.logout().catch(() => {});
    window.location.assign("/");
  };

  return (
    <div ref={container} className={cn("relative", !compact && "w-full")}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          compact
            ? "grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            : "side-nav-link w-full",
        )}
      >
        <Avatar user={user} compact={compact} />
        {!compact && (
          <span className="min-w-0 flex-1 truncate text-left">{userName(user)}</span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-50 min-w-48 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground",
            placement === "right"
              ? "bottom-0 left-full ml-2"
              : placement === "bottom"
                ? "top-full right-0 mt-2"
                : "bottom-full left-0 mb-2",
          )}
        >
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar user={user} />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{userName(user)}</p>
              {user?.login && (
                <p className="truncate text-[11px] text-muted-foreground">@{user.login}</p>
              )}
            </div>
          </div>
          <div className="my-1 h-px bg-border" />
          <button type="button" role="menuitem" className="account-menu-item" onClick={toggle}>
            {theme === "light" ? (
              <MoonIcon className="size-3.5" />
            ) : (
              <SunIcon className="size-3.5" />
            )}
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
          <Link
            href="/settings"
            role="menuitem"
            className="account-menu-item"
            onClick={() => setOpen(false)}
          >
            <Settings2Icon className="size-3.5" />
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            className="account-menu-item"
            onClick={() => void logout()}
          >
            <LogOutIcon className="size-3.5" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

type AccountMenuProps = { compact?: boolean; placement?: "top" | "right" | "bottom" };

function Avatar({ user, compact = false }: { user: AppUserSummary | null; compact?: boolean }) {
  const initials = userName(user)
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return user?.avatarUrl ? (
    // GitHub controls the URL; the image is decorative and never used for authorization.
    <Image
      src={user.avatarUrl}
      alt=""
      width={24}
      height={24}
      unoptimized
      className={cn("rounded-full object-cover", compact ? "size-6" : "size-6")}
    />
  ) : (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-foreground text-[10px] font-semibold text-background",
        compact ? "size-6" : "size-6",
      )}
    >
      {initials || "?"}
    </span>
  );
}

function userName(user: AppUserSummary | null): string {
  return user?.displayName || user?.login || "Account";
}
