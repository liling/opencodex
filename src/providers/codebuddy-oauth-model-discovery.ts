import { createHash, randomUUID } from "node:crypto";
import { providerOutboundGet } from "../lib/provider-outbound";
import type { OcxProviderConfig } from "../types";
import { isRegistryModelDiscoveryUrl, isValidModelDiscoveryModelId, MODEL_DISCOVERY_MAX_MODELS, MODEL_DISCOVERY_MAX_RESPONSE_BYTES, readBoundedDiscoveryJson } from "./model-discovery";

const REGIONS: Record<string, { host: string; domain: string }> = {
  "codebuddy-oauth": { host: "https://copilot.tencent.com", domain: "www.codebuddy.cn" },
  "codebuddy-oauth-global": { host: "https://www.codebuddy.ai", domain: "www.codebuddy.ai" },
};

function claims(token: string): Record<string, unknown> {
  try {
    const encoded = token.split(".")[1];
    const value: unknown = encoded && JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export function codeBuddyOAuthTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function discoveryHeaders(token: string, domain: string): Headers {
  const identity = claims(token);
  const tenant = identity.tenant_id ?? identity.tenantId
    ?? (typeof identity.iss === "string" ? identity.iss.match(/realms\/sso-([^/]+)$/)?.[1] : undefined);
  const roles = [
    ...((identity.realm_access && typeof identity.realm_access === "object" && Array.isArray((identity.realm_access as Record<string, unknown>).roles))
      ? (identity.realm_access as { roles: unknown[] }).roles : []),
    ...((identity.resource_access && typeof identity.resource_access === "object"
      && (identity.resource_access as Record<string, unknown>).account
      && typeof (identity.resource_access as { account: unknown }).account === "object"
      && Array.isArray(((identity.resource_access as { account: { roles?: unknown[] } }).account).roles))
      ? ((identity.resource_access as { account: { roles: unknown[] } }).account).roles : []),
  ];
  const enterprise = roles.find((role): role is string => typeof role === "string")?.match(/group-admin:([A-Za-z0-9-]+)/)?.[1]
    ?? identity.enterprise_id ?? identity.enterpriseId ?? identity.ent_id ?? identity.entId;
  const user = identity.user_id ?? identity.userId ?? identity.uid ?? identity.sub;
  const traceId = randomUUID().replaceAll("-", "");
  const spanId = randomUUID().replaceAll("-", "").slice(0, 16);
  const parentSpanId = randomUUID().replaceAll("-", "").slice(0, 16);
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    "X-Domain": domain,
    "X-Agent-Intent": "craft",
    "X-Product": "SaaS",
    Accept: "application/json, text/plain, */*",
    "User-Agent": "VSCode/1.119.0 CodeBuddy/4.9.29177644",
    "X-IDE-Type": "VSCode", "X-IDE-Name": "VSCode", "X-IDE-Version": "1.119.0",
    "X-Product-Version": "4.9.29177644", "X-Env-ID": "production", "X-Requested-With": "XMLHttpRequest",
    "X-Request-Trace-Id": traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId, "X-B3-ParentSpanId": parentSpanId, "X-B3-SpanId": spanId, "X-B3-Sampled": "1",
  });
  for (const [key, value] of [["X-User-Id", user], ["X-Tenant-Id", tenant], ["X-Enterprise-Id", enterprise]] as const) {
    if (typeof value === "string" && value.length > 0 && value.length <= 256) headers.set(key, value);
  }
  return headers;
}

export interface CodeBuddyOAuthModel {
  id: string;
  displayName?: string;
}

function codeBuddyDisplayName(item: Record<string, unknown>, id: string): string | undefined {
  const name = typeof item.name === "string" && item.name.trim().length > 0 && item.name.length <= 256
    ? item.name.trim() : id;
  const credits = item.credits;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return name === id ? undefined : name;
  return credits === 0 ? `${name} (Free)` : `${name} (x${credits})`;
}

export function parseCodeBuddyOAuthModels(value: unknown): CodeBuddyOAuthModel[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root.code !== 0) return null;
  const data = root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const payload = data as Record<string, unknown>;
  const dataModels = payload.models;
  const agents = payload.agents;
  if (!Array.isArray(dataModels) || !Array.isArray(agents)
    || dataModels.length > MODEL_DISCOVERY_MAX_MODELS || agents.length > MODEL_DISCOVERY_MAX_MODELS) return null;

  const supportedById = new Map<string, { supported: boolean; model: CodeBuddyOAuthModel } | null>();
  for (const row of dataModels) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const id = item.id;
    if (!isValidModelDiscoveryModelId(id)) continue;
    const displayName = codeBuddyDisplayName(item, id);
    supportedById.set(id, supportedById.has(id) ? null : {
      supported: item.supportsToolCall === true,
      model: { id, ...(displayName ? { displayName } : {}) },
    });
  }
  const craft = agents.find(agent => agent && typeof agent === "object" && !Array.isArray(agent)
    && (agent as Record<string, unknown>).name === "craft");
  if (!craft || typeof craft !== "object" || Array.isArray(craft)) return null;
  const agentModels = (craft as Record<string, unknown>).models;
  if (!Array.isArray(agentModels) || agentModels.length > MODEL_DISCOVERY_MAX_MODELS) return null;

  const result: CodeBuddyOAuthModel[] = [];
  const seen = new Set<string>();
  for (const id of agentModels) {
    if (!isValidModelDiscoveryModelId(id) || supportedById.get(id)?.supported !== true || seen.has(id)) continue;
    seen.add(id);
    result.push(supportedById.get(id)!.model);
  }
  // The reference client falls back to its universal selector when craft exposes
  // no usable tool-capable models.
  return result.length > 0 ? result : [{ id: "auto" }];
}

/** Kept as a compatibility projection for callers that only need identifiers. */
export function parseCodeBuddyOAuthModelIds(value: unknown): string[] | null {
  const models = parseCodeBuddyOAuthModels(value);
  return models?.map(model => model.id) ?? null;
}

export type CodeBuddyOAuthModelDiscovery = { ok: true; models: CodeBuddyOAuthModel[] } | { ok: false; error: string };

export async function fetchCodeBuddyOAuthModels(providerId: string, provider: OcxProviderConfig, token: string): Promise<CodeBuddyOAuthModelDiscovery> {
  const region = REGIONS[providerId];
  if (!region) return { ok: false, error: "unknown_region" };
  const url = `${region.host}/v3/config`;
  try {
    const response = await providerOutboundGet(providerId, provider, url, {
      headers: discoveryHeaders(token, region.domain), signal: AbortSignal.timeout(8000),
    }, { isCanonicalUrl: isRegistryModelDiscoveryUrl });
    if (!response.ok) {
      try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
      return { ok: false, error: `http_${response.status}` };
    }
    const bounded = await readBoundedDiscoveryJson(response, MODEL_DISCOVERY_MAX_RESPONSE_BYTES);
    if (!bounded.ok) return { ok: false, error: bounded.reason };
    if (!bounded.value || typeof bounded.value !== "object" || Array.isArray(bounded.value)
      || (bounded.value as Record<string, unknown>).code !== 0) return { ok: false, error: "upstream_rejected" };
    const models = parseCodeBuddyOAuthModels(bounded.value);
    return models ? { ok: true, models } : { ok: false, error: "invalid_shape" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "request_failed" };
  }
}
