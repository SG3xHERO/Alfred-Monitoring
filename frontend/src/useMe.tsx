import { createContext, useContext, useEffect, useState } from "react";
import { get } from "./api";

export interface Me {
  username: string;
  role: "admin" | "operator" | "viewer";
}

const MeContext = createContext<Me | null>(null);

/** Provides the signed-in user + role to everything under the Shell. */
export function MeProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    get<Me>("/api/auth/me").then(setMe).catch(() => {});
  }, []);
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): Me | null {
  return useContext(MeContext);
}

/** False until /api/auth/me confirms the admin role — viewers never flash admin controls. */
export function useIsAdmin(): boolean {
  return useContext(MeContext)?.role === "admin";
}

/** True for admin or operator — "can manage" infrastructure/alerting, but not necessarily Settings/users. */
export function useCanManage(): boolean {
  const role = useContext(MeContext)?.role;
  return role === "admin" || role === "operator";
}
