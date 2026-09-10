import { PublicClientApplication, InteractionRequiredAuthError } from "@azure/msal-browser";
import { get, post } from "./api";

interface MicrosoftConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
}

let pca: PublicClientApplication | null = null;
let initPromise: Promise<PublicClientApplication | null> | null = null;

/** Lazily builds the MSAL app from backend-supplied config (tenant/client id live in Settings, not a build-time env var). */
async function getMsal(): Promise<PublicClientApplication | null> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cfg = await get<MicrosoftConfig>("/api/auth/microsoft/config").catch(() => null);
    if (!cfg?.enabled) return null;
    const instance = new PublicClientApplication({
      auth: {
        clientId: cfg.clientId,
        authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
        redirectUri: window.location.origin,
      },
      cache: { cacheLocation: "sessionStorage" },
    });
    await instance.initialize();
    pca = instance;
    return instance;
  })();
  return initPromise;
}

export async function microsoftSignInAvailable(): Promise<boolean> {
  return (await getMsal()) !== null;
}

/**
 * Opens the Microsoft sign-in popup, reads the caller's group membership
 * from Graph with the same access token (User.Read is enough for reading
 * one's own memberships — no admin consent needed), and hands both tokens
 * to the backend to verify and turn into an Alfred session.
 */
export async function signInWithMicrosoft(): Promise<{ ok: true; username: string }> {
  const instance = await getMsal();
  if (!instance) throw new Error("Microsoft sign-in is not configured");

  const scopes = ["openid", "profile", "User.Read"];
  const result = await instance.loginPopup({ scopes, prompt: "select_account" });

  let accessToken = result.accessToken;
  if (!accessToken) {
    try {
      const silent = await instance.acquireTokenSilent({ scopes, account: result.account });
      accessToken = silent.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        const popup = await instance.acquireTokenPopup({ scopes, account: result.account });
        accessToken = popup.accessToken;
      } else {
        throw err;
      }
    }
  }

  return post("/api/auth/microsoft", { idToken: result.idToken, accessToken });
}
