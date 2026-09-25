import type { ProviderAdapter } from "./base";
import { createOpenAIChatAdapter } from "./openai-chat";
import type { OcxProviderConfig } from "../types";

const REGIONS: Record<string, { baseUrl: string; domain: string }> = {
  "codebuddy-oauth": { baseUrl: "https://copilot.tencent.com", domain: "www.codebuddy.cn" },
  "codebuddy-oauth-global": { baseUrl: "https://www.codebuddy.ai", domain: "www.codebuddy.ai" },
};

function claims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1];
    const value: unknown = payload && JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export function createCodeBuddyOAuthAdapter(provider: OcxProviderConfig, providerId: string): ProviderAdapter {
  const inferredId = Object.entries(REGIONS).find(([, value]) => value.baseUrl === provider.baseUrl)?.[0];
  const resolvedId = providerId || inferredId;
  const region = resolvedId ? REGIONS[resolvedId] : undefined;
  if (!region) throw new Error("Unknown CodeBuddy OAuth region");
  if (providerId && inferredId && inferredId !== providerId) throw new Error("CodeBuddy OAuth region mismatch");
  // Ignore persisted destination, endpoint, and header overrides before constructing the request.
  const safeProvider: OcxProviderConfig = {
    ...provider,
    adapter: "codebuddy-oauth",
    baseUrl: region.baseUrl,
    chatCompletionsPath: "/v2/chat/completions",
    headers: {},
    authMode: "oauth",
  };
  const adapter = createOpenAIChatAdapter(safeProvider);
  return {
    ...adapter,
    name: "codebuddy-oauth",
    async buildRequest(parsed, incoming) {
      const request = await adapter.buildRequest(parsed, incoming);
      // Defense in depth: even an upstream change in the shared URL builder cannot send a
      // bearer to a configured/custom destination.
      const token = provider.apiKey ?? "";
      const identity = claims(token);
      const traceId = crypto.randomUUID().replaceAll("-", "");
      const spanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      const parentSpanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
      const conversationId = crypto.randomUUID().replaceAll("-", "");
      const requestId = crypto.randomUUID().replaceAll("-", "");
      const tenant = identity.tenant_id ?? identity.tenantId
        ?? (typeof identity.iss === "string" ? identity.iss.match(/realms\/sso-([^/]+)$/)?.[1] : undefined);
      const roles = [
        ...((identity.realm_access && typeof identity.realm_access === "object"
          && Array.isArray((identity.realm_access as Record<string, unknown>).roles))
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
      const headers: Record<string, string> = {
        ...request.headers,
        Authorization: `Bearer ${token}`,
        "X-Domain": region.domain,
        "X-Agent-Intent": "craft",
        "X-Product": "SaaS",
        Accept: "application/json, text/plain, */*",
        "User-Agent": "VSCode/1.119.0 CodeBuddy/4.9.29177644",
        "X-IDE-Type": "VSCode",
        "X-IDE-Name": "VSCode",
        "X-IDE-Version": "1.119.0",
        "X-Product-Version": "4.9.29177644",
        "X-Env-ID": "production",
        "X-Requested-With": "XMLHttpRequest",
        "X-Model-ID": parsed.modelId,
        "X-Request-Trace-Id": traceId,
        "X-Request-ID": requestId,
        "X-Conversation-ID": conversationId,
        "X-Conversation-Request-ID": requestId,
        "X-Conversation-Message-ID": requestId,
        b3: `${traceId}-${spanId}-1-${parentSpanId}`,
        "X-B3-TraceId": traceId,
        "X-B3-ParentSpanId": parentSpanId,
        "X-B3-SpanId": spanId,
        "X-B3-Sampled": "1",
      };
      for (const [header, value] of [["X-User-Id", user], ["X-Tenant-Id", tenant], ["X-Enterprise-Id", enterprise]] as const) {
        if (typeof value === "string" && value.length > 0 && value.length <= 256) headers[header] = value;
      }
      return { ...request, url: `${region.baseUrl}/v2/chat/completions`, headers };
    },
  };
}
