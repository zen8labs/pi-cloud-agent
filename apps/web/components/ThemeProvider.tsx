"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: "light", toggle: () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Always start with "light" so server and client render identical HTML.
  // The inline <head> script has already set data-theme on <html> before
  // React hydrates, so the visual theme is correct from the first paint.
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    // After hydration, read what the inline script already applied so our
    // React state matches the actual rendered theme.
    const applied = document.documentElement.getAttribute("data-theme") as Theme | null;
    if (applied === "dark") setTheme("dark");
  }, []);

  const toggle = () => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("pca-theme", next);
      return next;
    });
  };

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}
