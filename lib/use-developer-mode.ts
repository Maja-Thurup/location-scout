"use client";

import { useCallback, useEffect, useState } from "react";

export const DEVELOPER_MODE_STORAGE_KEY = "locationscout:developerMode";

export function useDeveloperMode(): {
  developerMode: boolean;
  setDeveloperMode: (value: boolean) => void;
  hydrated: boolean;
} {
  const [developerMode, setDeveloperModeState] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setDeveloperModeState(
        localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY) === "true",
      );
    } catch {
      setDeveloperModeState(false);
    }
    setHydrated(true);
  }, []);

  const setDeveloperMode = useCallback((value: boolean) => {
    setDeveloperModeState(value);
    try {
      localStorage.setItem(DEVELOPER_MODE_STORAGE_KEY, value ? "true" : "false");
    } catch {
      // ignore quota / private mode
    }
  }, []);

  return { developerMode, setDeveloperMode, hydrated };
}
