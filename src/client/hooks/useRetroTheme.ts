import { useEffect, useRef, useState } from "react";

import { KONAMI_SEQUENCE, matchesKonami, normalizeKonamiKey } from "../konami-code";

const RETRO_THEME_STORAGE_KEY = "ping-pong.retroTheme";
const RETRO_THEME_CLASS = "retro-nes";

function readStoredRetroTheme(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(RETRO_THEME_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useRetroTheme(): boolean {
  const [enabled, setEnabled] = useState(readStoredRetroTheme);
  const keyBufferRef = useRef<string[]>([]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(RETRO_THEME_CLASS, enabled);
    try {
      window.localStorage.setItem(RETRO_THEME_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Persistence is best-effort; the theme still applies for this session.
    }
    return () => root.classList.remove(RETRO_THEME_CLASS);
  }, [enabled]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const buffer = keyBufferRef.current;
      buffer.push(normalizeKonamiKey(event.key));
      if (buffer.length > KONAMI_SEQUENCE.length) {
        buffer.splice(0, buffer.length - KONAMI_SEQUENCE.length);
      }
      if (matchesKonami(buffer)) {
        keyBufferRef.current = [];
        setEnabled((value) => !value);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return enabled;
}
