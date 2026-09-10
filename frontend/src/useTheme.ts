import { useCallback, useState } from "react";

export type UiTheme = "modern" | "classic";

const KEY = "alfred-theme";

/**
 * Temporary switch between the new default look and the original "classic"
 * theme, kept only until the new theme is settled — see index.css.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<UiTheme>(
    () => (localStorage.getItem(KEY) === "classic" ? "classic" : "modern"),
  );

  const setTheme = useCallback((next: UiTheme) => {
    if (next === "classic") {
      document.documentElement.setAttribute("data-theme", "classic");
      localStorage.setItem(KEY, "classic");
    } else {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem(KEY);
    }
    setThemeState(next);
  }, []);

  return { theme, setTheme };
}
