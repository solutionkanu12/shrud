"use client";

/**
 * Which Safe this browser is operating.
 *
 * `ShrudModuleFactory.moduleOf` is keyed by SAFE, not by owner — see the note on `useModuleOf`. Five
 * pages were passing the connected EOA into it, which is documented to return nothing for a plain
 * wallet, so every one of them reported "no module" permanently and could not be reached at all.
 *
 * The Safe is remembered rather than re-entered on each page, because it is a property of the
 * treasury being operated and not of the screen being looked at. It is NOT authority: nothing here
 * can sign, and a wrong value produces a read that finds no module rather than a transaction
 * against someone else's account.
 */

import { useCallback, useEffect, useState } from "react";
import { type Address, isAddress } from "viem";

const KEY = "shrud.activeSafe";

/** Fired on write so every mounted hook updates, which `storage` alone does not do in one tab. */
const CHANGED = "shrud.activeSafe.changed";

function read(): Address | undefined {
  if (typeof window === "undefined") return undefined;
  const stored = window.localStorage.getItem(KEY);
  if (stored === null || !isAddress(stored)) return undefined;
  return stored;
}

export function useActiveSafe(): {
  safe: Address | undefined;
  setSafe: (next: Address | undefined) => void;
} {
  // Starts undefined on every render path so the server and the first client render agree. A
  // localStorage read during render would differ between them and produce a hydration mismatch.
  const [safe, setLocal] = useState<Address | undefined>(undefined);

  useEffect(() => {
    setLocal(read());
    const sync = () => {
      setLocal(read());
    };
    window.addEventListener(CHANGED, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setSafe = useCallback((next: Address | undefined) => {
    if (next === undefined) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);

  return { safe, setSafe };
}
