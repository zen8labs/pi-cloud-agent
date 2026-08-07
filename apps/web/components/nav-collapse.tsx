"use client";

import { createContext, useContext, useEffect, useState } from "react";

// The previous key could leave users in the broken, oversized collapsed rail
// from the first resizable-sidebar implementation. Start the corrected layout
// expanded once, then persist intentional collapse/expand choices normally.
const STORAGE_KEY = "pca-nav-collapsed-v2";
const WIDTH_STORAGE_KEY = "pca-nav-width-v2";
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 180;
const MAX_WIDTH = 360;

type NavCollapse = {
  collapsed: boolean;
  toggle: () => void;
  expand: () => void;
  width: number;
  resize: (width: number) => void;
  resetWidth: () => void;
};

const NavCollapseContext = createContext<NavCollapse>({
  collapsed: false,
  toggle: () => {},
  expand: () => {},
  width: DEFAULT_WIDTH,
  resize: () => {},
  resetWidth: () => {},
});

export function NavCollapseProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(STORAGE_KEY) === "1");
      const storedWidth = localStorage.getItem(WIDTH_STORAGE_KEY);
      if (storedWidth !== null && Number.isFinite(Number(storedWidth))) {
        setWidth(clampWidth(Number(storedWidth)));
      }
    } catch {
      // Storage unavailable: keep the default expanded navigation.
    }
  }, []);
  const toggle = () =>
    setCollapsed((current) => {
      try {
        localStorage.setItem(STORAGE_KEY, current ? "0" : "1");
      } catch {
        // Persisting is best-effort; the toggle still works for the session.
      }
      return !current;
    });
  const expand = () => {
    setCollapsed(false);
    try {
      localStorage.setItem(STORAGE_KEY, "0");
    } catch {
      // Persisting is best-effort; expansion still works for the session.
    }
  };
  const resize = (nextWidth: number) => {
    const next = clampWidth(nextWidth);
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
    } catch {
      // Persisting is best-effort; resizing still works for the session.
    }
  };
  const resetWidth = () => resize(DEFAULT_WIDTH);
  return (
    <NavCollapseContext.Provider
      value={{ collapsed, toggle, expand, width, resize, resetWidth }}
    >
      {children}
    </NavCollapseContext.Provider>
  );
}

export function useNavCollapse(): NavCollapse {
  return useContext(NavCollapseContext);
}

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

export { MAX_WIDTH, MIN_WIDTH };
