import { useCallback, useEffect, useState } from 'react';

// Custom hooks live in their own files (NOT alongside components) to satisfy the
// React Fast Refresh rule.
//
// `document`, `window` and `fetch` work normally in the immediately.run iframe.
// **`localStorage` does not.** Apps run at an opaque origin (a sandboxed iframe
// without `allow-same-origin`), where the browser makes even *reading* the
// property throw `SecurityError` — so a `typeof localStorage === 'undefined'`
// guard is not enough, and the throw happens before any value comes back. Every
// access needs a real try/catch. That is also why this cannot be a module-level
// constant: touching it at import time takes the whole app down.
//
// The practical consequence: treat browser storage as a per-session nicety that
// may simply not be there, and make sure the app is fully usable without it.

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'immediately-run-app-theme';

/** Read the persisted theme, or `null` when storage is unavailable (the
 *  sandboxed-iframe case) or holds nothing. Never throws. */
function readStoredTheme(): Theme | null {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : null;
  } catch {
    return null;
  }
}

/** Persist the theme, best-effort. A failure here is not an app error: the theme
 *  still works for this session, it just won't survive a reload. */
function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // No storage at this origin — session-only, by design.
  }
}

// Persists the color theme to localStorage where that is available, and reflects
// it on <html> as a `data-theme` attribute, matching the CSS in index.css. `dark`
// is the default, represented by the absence of the attribute.
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? 'dark');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    storeTheme(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  }, []);

  return { theme, toggle };
}
