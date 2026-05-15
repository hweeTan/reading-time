import { useCallback, useState } from "react";

export function useLocalStorage(
  key: string,
  initial: string = ""
): [string, (value: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });

  const setStored = useCallback(
    (next: string) => {
      setValue(next);
      try {
        if (next) localStorage.setItem(key, next);
        else localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
    [key]
  );

  return [value, setStored];
}
