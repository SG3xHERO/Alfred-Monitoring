import { useEffect, useState } from "react";
import { get } from "./api";

export interface Brand {
  id: number;
  name: string;
  sort: number;
  is_default: boolean;
}

let cache: Brand[] | null = null;
let inflight: Promise<Brand[]> | null = null;
const listeners = new Set<(b: Brand[]) => void>();

function load(): Promise<Brand[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = get<Brand[]>("/api/brands").then((b) => {
      cache = b;
      inflight = null;
      return b;
    });
  }
  return inflight;
}

/** Call after creating/renaming/deleting a brand so every open useBrands() consumer refetches. */
export function invalidateBrands(): void {
  cache = null;
  inflight = null;
  load().then((b) => listeners.forEach((fn) => fn(b)));
}

/** The admin-curated brand/group list, plus the one marked default (falls back to "Ungrouped" if none exist yet). */
export function useBrands(): { brands: Brand[]; names: string[]; defaultBrand: string } {
  const [brands, setBrands] = useState<Brand[]>(cache ?? []);

  useEffect(() => {
    let live = true;
    load().then((b) => { if (live) setBrands(b); });
    const onChange = (b: Brand[]) => { if (live) setBrands(b); };
    listeners.add(onChange);
    return () => { live = false; listeners.delete(onChange); };
  }, []);

  const defaultBrand = brands.find((b) => b.is_default)?.name ?? brands[0]?.name ?? "Ungrouped";
  return { brands, names: brands.map((b) => b.name), defaultBrand };
}
