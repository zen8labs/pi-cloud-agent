"use client";

import { createContext, useContext, useEffect, useState } from "react";

const STORAGE_KEY = "pca-nav-collapsed";

type NavCollapse = { collapsed: boolean; toggle: () => void };

const NavCollapseContext = createContext<NavCollapse>({ collapsed: false, toggle: () => {} });

export function NavCollapseProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(STORAGE_KEY) === "1");
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
  return (
    <NavCollapseContext.Provider value={{ collapsed, toggle }}>
      {children}
    </NavCollapseContext.Provider>
  );
}

export function useNavCollapse(): NavCollapse {
  return useContext(NavCollapseContext);
}
