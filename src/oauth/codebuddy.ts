import type { OAuthController, OAuthCredentials } from "./types";
import { readBoundedResponseBytes } from "../lib/bounded-body";

const REGIONS = {
  "codebuddy-oauth": { host: "https://copilot.tencent.com", platform: "VSCode" },
  "codebuddy-oauth-global": { host: "https://www.codebuddy.ai", platform: "VSCode" },
} as const;
const REQUEST_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

type RegionId = keyof typeof REGIONS;
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid CodeBuddy OAuth response");
  return value as JsonRecord;
}

async function boundedJson(response: Response, signal?: AbortSignal): Promise<JsonRecord> {
  if (!response.ok) throw new Error(`CodeBuddy OAuth request failed (${response.status})`);
  const { bytes, oversized } = await readBoundedResponseBytes(response, { maxBytes: MAX_RESPONSE_BYTES, signal, inactivityTimeoutMs: REQUEST_TIMEOUT_MS });
  if (oversized) throw new Error("CodeBuddy OAuth response too large");
  try { return record(JSON.parse(new TextDecoder().decode(bytes))); }
  catch { throw new Error("Invalid CodeBuddy OAuth JSON response"); }
}

function responseCode(payload: JsonRecord): number {
  if (typeof payload.code !== "number" || !Number.isInteger(payload.code)) throw new Error("Invalid CodeBuddy OAuth response");
  return payload.code;
}

function validAuthUrl(provider: RegionId, value: string): URL | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const hosts = provider === "codebuddy-oauth"
    ? ["copilot.tencent.com", "codebuddy.cn"]
    : ["codebuddy.ai"];
  return hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url : undefined;
}

function signalFor(signal: AbortSignal | undefined, deadline: number): AbortSignal {
  const timeout = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}

function decodeClaims(token: string): JsonRecord {
  try {
    const part = token.split(".")[1];
    return part ? record(JSON.parse(Buffer.from(part, "base64url").toString("utf8"))) : {};
  } catch { return {}; }
}

function credentials(access: string, refresh: string, expiresIn: unknown): OAuthCredentials {
  const claims = decodeClaims(access);
  const email = typeof claims.email === "string" && claims.email.length < 320 ? claims.email.toLowerCase() : undefined;
  const identity = claims.user_id ?? claims.userId ?? claims.uid ?? claims.sub;
  const tenant = claims.tenant_id ?? claims.tenantId
    ?? (typeof claims.iss === "string" ? claims.iss.match(/realms\/sso-([^/]+)$/)?.[1] : undefined);
  const accountId = typeof identity === "string" && identity.length > 0 && identity.length <= 240
    ? (typeof tenant === "string" && tenant.length > 0 && tenant.length <= 256 ? `${tenant}:${identity}` : identity)
    : undefined;
  const jwtExpiry = typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > Date.now() / 1000
    ? claims.exp * 1000
    : undefined;
  const expiry = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
    ? Date.now() + Math.max(60, expiresIn) * 1000
    : jwtExpiry ?? Date.now() + 24 * 60 * 60 * 1000;
  return {
    access, refresh,
    expires: expiry,
    ...(email ? { email } : {}), ...(accountId ? { accountId } : {}),
  };
}

export async function loginCodeBuddyOAuth(provider: RegionId, ctrl: OAuthController): Promise<OAuthCredentials> {
  const { host, platform } = REGIONS[provider];
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  if (ctrl.signal?.aborted) throw new Error("CodeBuddy login cancelled");
  const startSignal = signalFor(ctrl.signal, deadline);
  const started = await boundedJson(await fetch(`${host}/v2/plugin/auth/state?platform=${platform}&ioa=1`, {
    method: "POST", headers: {
      Accept: "application/json", "Content-Type": "application/json", "X-No-Authorization": "true",
      "X-No-User-Id": "true", "X-No-Enterprise-Id": "true", "X-No-Department-Info": "true",
    }, signal: startSignal,
  }), startSignal);
  if (responseCode(started) !== 0) throw new Error("CodeBuddy OAuth state request was rejected");
  const stateData = record(started.data);
  const state = stateData.state;
  if (typeof state !== "string" || !state || state.length > 2048) throw new Error("Invalid CodeBuddy OAuth state response");
  const loginUrl = typeof stateData.authUrl === "string" && stateData.authUrl.length > 0
    ? stateData.authUrl
    : `${host}/login?platform=${encodeURIComponent(platform)}&state=${encodeURIComponent(state)}&ioa=1`;
  const authUrl = validAuthUrl(provider, loginUrl);
  if (!authUrl) throw new Error("Invalid CodeBuddy OAuth login URL");
  ctrl.onAuth?.({ url: authUrl.toString(), instructions: "Complete CodeBuddy sign-in in your browser." });
  while (Date.now() < deadline) {
    if (ctrl.signal?.aborted) throw new Error("CodeBuddy login cancelled");
    await new Promise<void>((resolve, reject) => {
      const signal = ctrl.signal;
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => { cleanup(); resolve(); }, 3000);
      const onAbort = () => { clearTimeout(timer); cleanup(); reject(new Error("CodeBuddy login cancelled")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const pollSignal = signalFor(ctrl.signal, deadline);
    const result = await boundedJson(await fetch(`${host}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      headers: {
        Accept: "application/json", "X-No-Authorization": "true", "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true", "X-No-Department-Info": "true",
      }, signal: pollSignal,
    }), pollSignal);
    if (responseCode(result) !== 0) continue;
    const tokenData = record(result.data);
    const access = tokenData.accessToken;
    const refresh = typeof tokenData.refreshToken === "string" ? tokenData.refreshToken : "";
    if (typeof access === "string" && access.length > 0) {
      return credentials(access, refresh, tokenData.expiresIn);
    }
    throw new Error("Invalid CodeBuddy OAuth token response");
  }
  throw new Error("CodeBuddy login timed out");
}

export async function refreshCodeBuddyOAuth(provider: RegionId, refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  if (!refreshToken) throw new Error("expired_token");
  const { host } = REGIONS[provider];
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${host}/v2/plugin/auth/token/refresh`, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${refreshToken}` },
    signal: requestSignal,
  });
  const result = await boundedJson(response, requestSignal);
  if (responseCode(result) !== 0) throw new Error("CodeBuddy token refresh was rejected");
  const data = record(result.data);
  const access = data.accessToken;
  const refresh = data.refreshToken ?? refreshToken;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) throw new Error("Invalid CodeBuddy refresh response");
  return credentials(access, refresh, data.expiresIn);
}
