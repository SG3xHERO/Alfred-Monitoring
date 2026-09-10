import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { getSetting } from "./settings.js";

/**
 * Microsoft Entra ID (Azure AD) sign-in. The frontend runs an MSAL popup
 * (auth code + PKCE, no client secret needed for a SPA registration) and
 * hands us the resulting ID token plus a Graph access token. We verify the
 * ID token ourselves against the tenant's JWKS rather than trusting the
 * client, and use the Graph token server-side to read the caller's own
 * group membership — so a malicious client can't just claim a role.
 */

export interface AzureProfile {
  oid: string;
  email: string;
  name: string;
}

let jwks: jwksClient.JwksClient | null = null;
let jwksTenant = "";

function jwksForTenant(tenantId: string): jwksClient.JwksClient {
  if (!jwks || jwksTenant !== tenantId) {
    jwks = jwksClient({
      jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 24 * 3600 * 1000,
      rateLimit: true,
    });
    jwksTenant = tenantId;
  }
  return jwks;
}

export function azureConfigured(): boolean {
  return (
    getSetting("azure.enabled") === "true" &&
    !!getSetting("azure.tenant_id") &&
    !!getSetting("azure.client_id")
  );
}

export function azurePublicConfig() {
  return {
    enabled: azureConfigured(),
    tenantId: getSetting("azure.tenant_id"),
    clientId: getSetting("azure.client_id"),
  };
}

/** Verifies signature, issuer and audience; throws on any mismatch. */
export async function validateAzureIdToken(idToken: string): Promise<AzureProfile> {
  const tenantId = getSetting("azure.tenant_id");
  const clientId = getSetting("azure.client_id");
  if (!tenantId || !clientId) throw new Error("Microsoft sign-in is not configured");

  const client = jwksForTenant(tenantId);
  const getKey: jwt.GetPublicKeyOrSecret = (header, callback) => {
    client.getSigningKey(header.kid, (err, key) => {
      if (err || !key) return callback(err ?? new Error("no signing key"));
      callback(null, key.getPublicKey());
    });
  };

  const decoded = await new Promise<jwt.JwtPayload>((resolve, reject) => {
    jwt.verify(idToken, getKey, { audience: clientId, algorithms: ["RS256"] }, (err, payload) => {
      if (err || !payload || typeof payload === "string") return reject(err ?? new Error("invalid token"));
      resolve(payload);
    });
  });

  const validIssuers = [
    `https://login.microsoftonline.com/${tenantId}/v2.0`,
    `https://sts.windows.net/${tenantId}/`,
  ];
  if (!validIssuers.includes(String(decoded.iss))) {
    throw new Error("invalid token issuer");
  }

  const oid = decoded.oid as string;
  if (!oid) throw new Error("token has no oid claim");
  return {
    oid,
    email: (decoded.preferred_username || decoded.email || "") as string,
    name: (decoded.name || decoded.preferred_username || "") as string,
  };
}

/** Reads the caller's own (transitive) group memberships via Graph, using their delegated access token. */
export async function fetchGraphGroupIds(accessToken: string): Promise<string[]> {
  const ids: string[] = [];
  let url: string | null =
    "https://graph.microsoft.com/v1.0/me/transitiveMemberOf/microsoft.graph.group?$select=id";
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Graph group lookup failed (${res.status})`);
    }
    const data = (await res.json()) as { value: { id: string }[]; "@odata.nextLink"?: string };
    for (const g of data.value) ids.push(g.id);
    url = data["@odata.nextLink"] ?? null;
  }
  return ids;
}

/** admin beats operator beats viewer; null means the account isn't in any recognised role group. */
export function roleFromGroupIds(groupIds: string[]): "admin" | "operator" | "viewer" | null {
  const set = new Set(groupIds.filter(Boolean));
  const admin = getSetting("azure.group_admin");
  const operator = getSetting("azure.group_operator");
  const viewer = getSetting("azure.group_viewer");
  if (admin && set.has(admin)) return "admin";
  if (operator && set.has(operator)) return "operator";
  if (viewer && set.has(viewer)) return "viewer";
  return null;
}
