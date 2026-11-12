import { useCallback, useSyncExternalStore } from "react";

// 화면 상단 제목(=크롬 탭 제목)도 컴퓨터(브라우저)별로 기억한다.
export const DEFAULT_TITLE = "주식알리미";
const KEY = "sp_title";
const listeners = new Set<() => void>();

function snapshot(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT_TITLE;
  } catch {
    return DEFAULT_TITLE;
  }
}

export function useAppTitle(): [string, (t: string) => void] {
  const title = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => e.key === KEY && cb();
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    snapshot,
    () => DEFAULT_TITLE,
  );
  const set = useCallback((t: string) => {
    const v = t.trim().slice(0, 30);
    try {
      if (!v || v === DEFAULT_TITLE) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, v);
    } catch {
      /* 저장 불가 환경 — 무시 */
    }
    listeners.forEach((l) => l());
  }, []);
  return [title, set];
}
