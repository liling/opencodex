import { afterEach, describe, expect, jest, test } from "bun:test";
import { loginCodeBuddyOAuth, refreshCodeBuddyOAuth } from "../../src/oauth/codebuddy";
import { fetchCodeBuddyOAuthModels, parseCodeBuddyOAuthModelIds, parseCodeBuddyOAuthModels } from "../../src/providers/codebuddy-oauth-model-discovery";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { captureProviderGather } from "../../src/codex/catalog/gather-capture";
import { fetchProviderModelsWithAuth } from "../../src/codex/catalog/provider-models";
import { clearModelCache } from "../../src/codex/model-cache";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearModelCache();
  if (jest.isFakeTimers()) {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

describe("CodeBuddy OAuth", () => {
  test("live discovery merges data and craft models and admits only tool-call models", () => {
    const parsed = parseCodeBuddyOAuthModelIds({ code: 0, data: {
      models: [
        { id: "chat-only", supportsToolCall: false },
        { id: "shared", name: "Shared Model", credits: 0.06, supportsToolCall: true },
        { id: "craft-model", name: "Craft Model", credits: 0, supportsToolCall: true },
        { id: "not-in-craft", supportsToolCall: true },
      ],
      agents: [{ name: "chat", models: ["chat-only"] }, { name: "craft", models: ["shared", "craft-model", "chat-only", "shared", "unknown"] }],
    } });
    expect(parsed).toEqual(["shared", "craft-model"]);
    expect(parseCodeBuddyOAuthModels({ code: 0, data: {
      models: [
        { id: "priced", name: "Price Model", credits: 0.78, supportsToolCall: true },
        { id: "free", name: "Free Model", credits: 0, supportsToolCall: true },
        { id: "unknown-price", name: "Unknown Price", supportsToolCall: true },
      ],
      agents: [{ name: "craft", models: ["priced", "free", "unknown-price"] }],
    } })).toEqual([
      { id: "priced", displayName: "Price Model (x0.78)" },
      { id: "free", displayName: "Free Model (Free)" },
      { id: "unknown-price", displayName: "Unknown Price" },
    ]);
    expect(parseCodeBuddyOAuthModelIds({ code: 0, data: { models: [], agents: [{ name: "craft", models: [] }] } })).toEqual(["auto"]);
    expect(parseCodeBuddyOAuthModelIds({ code: 1, data: { models: [], agents: [{ name: "craft", models: [] }] } })).toBeNull();
    expect(parseCodeBuddyOAuthModelIds({ data: { models: [], agents: [{ name: "craft", models: [] }] } })).toBeNull();
    expect(parseCodeBuddyOAuthModelIds({ code: 0, data: { models: [], agents: { craft: { models: [] } } } })).toBeNull();
  });

  test("both regional presets opt into fixed-host live discovery with auto fallback", () => {
    expect(getProviderRegistryEntry("codebuddy-oauth")).toMatchObject({
      liveModels: true, models: ["auto"], modelDiscovery: { url: "https://copilot.tencent.com/v3/config" },
    });
    expect(getProviderRegistryEntry("codebuddy-oauth-global")).toMatchObject({
      liveModels: true, models: ["auto"], modelDiscovery: { url: "https://www.codebuddy.ai/v3/config" },
    });
  });

  test("live discovery uses the fixed regional URL and CodeBuddy identity headers", async () => {
    let requestedUrl = "";
    let requestHeaders = new Headers();
    const tokenPayload = Buffer.from(JSON.stringify({ sub: "user-1", tenant_id: "tenant-1" })).toString("base64url");
    const token = `header.${tokenPayload}.signature`;
    const provider = {
      adapter: "codebuddy-oauth", baseUrl: "https://copilot.tencent.com", authMode: "oauth",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrl = String(input);
        requestHeaders = new Headers(init?.headers);
        return json({ code: 0, data: { models: [{ id: "tool-model", name: "Tool Model", credits: 0.06, supportsToolCall: true }], agents: [{ name: "craft", models: ["tool-model"] }] } });
      },
    } as never;
    const result = await fetchCodeBuddyOAuthModels("codebuddy-oauth", provider, token);
    expect(requestedUrl).toBe("https://copilot.tencent.com/v3/config");
    expect(requestHeaders.get("Authorization")).toBe(`Bearer ${token}`);
    expect(requestHeaders.get("X-Domain")).toBe("www.codebuddy.cn");
    expect(requestHeaders.get("X-Agent-Intent")).toBe("craft");
    expect(requestHeaders.get("X-User-Id")).toBe("user-1");
    expect(requestHeaders.get("X-Tenant-Id")).toBe("tenant-1");
    expect(result).toEqual({ ok: true, models: [{ id: "tool-model", displayName: "Tool Model (x0.06)" }] });
  });

  test("catalog discovery publishes available craft models instead of the fallback", async () => {
    clearModelCache();
    const token = "catalog-test-token";
    const provider = {
      ...getProviderRegistryEntry("codebuddy-oauth")!,
      adapter: "codebuddy-oauth",
      authMode: "oauth",
      fetch: async () => json({ code: 0, data: {
        models: [
          { id: "craft-one", name: "Craft One", credits: 0.78, supportsToolCall: true },
          { id: "chat-only", supportsToolCall: false },
        ],
        agents: [{ name: "chat", models: ["chat-only"] }, { name: "craft", models: ["craft-one"] }],
      } }),
    } as never;
    const auth = { kind: "observed", resolve: () => ({ apiKey: token, observed: true }) } as const;
    const captured = captureProviderGather("codebuddy-oauth", provider, auth);
    const discovered = await fetchProviderModelsWithAuth(captured, 60_000, undefined, auth);
    expect(discovered.models.map(model => model.id)).toContain("craft-one");
    expect(discovered.models.find(model => model.id === "craft-one")?.displayName).toBe("Craft One (x0.78)");
    expect(discovered.models.map(model => model.id)).not.toContain("chat-only");
    expect(discovered.models.map(model => model.id)).not.toContain("auto");
    expect(discovered.outcome.state).toBe("authoritative");
    clearModelCache();
  });

  test("nested state and token envelopes complete login and expose the trusted callback URL", async () => {
    jest.useFakeTimers();
    const requests: string[] = [];
    globalThis.fetch = (async input => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/state?")) return json({ code: 0, data: { state: "state-1", authUrl: "https://login.codebuddy.cn/oauth?state=state-1" } });
      return json({ code: 0, data: { accessToken: "access", refreshToken: "refresh", expiresIn: 3600 } });
    }) as typeof fetch;
    let callbackUrl: string | undefined;
    const pending = loginCodeBuddyOAuth("codebuddy-oauth", { onAuth: info => { callbackUrl = info.url; } });
    for (let attempt = 0; attempt < 4 && requests.length < 2; attempt++) {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(3000);
    }
    const credentials = await pending;

    expect(callbackUrl).toBe("https://login.codebuddy.cn/oauth?state=state-1");
    expect(credentials).toMatchObject({ access: "access", refresh: "refresh" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toStartWith("https://copilot.tencent.com/v2/plugin/auth/state?");
    expect(requests[1]).toStartWith("https://copilot.tencent.com/v2/plugin/auth/token?");
  });

  test.each([
    ["CN rejects unrelated HTTPS host", "codebuddy-oauth", "https://evil.example.test/login"],
    ["CN rejects deceptive suffix", "codebuddy-oauth", "https://copilot.tencent.com.evil.test/login"],
    ["Global rejects CN host", "codebuddy-oauth-global", "https://copilot.tencent.com/login"],
  ] as const)("%s", async (_name, provider, authUrl) => {
    globalThis.fetch = (async () => json({ code: 0, data: { state: "state-1", authUrl } })) as typeof fetch;
    let called = false;
    await expect(loginCodeBuddyOAuth(provider, { onAuth: () => { called = true; } })).rejects.toThrow("Invalid CodeBuddy OAuth login URL");
    expect(called).toBe(false);
  });

  test("credentials in an otherwise trusted URL are rejected", async () => {
    const authUrl = new URL("https://login.codebuddy.cn/login");
    authUrl.username = "user";
    authUrl.password = "pass";
    globalThis.fetch = (async () => json({ code: 0, data: { state: "state-1", authUrl: authUrl.toString() } })) as typeof fetch;
    await expect(loginCodeBuddyOAuth("codebuddy-oauth", {})).rejects.toThrow("Invalid CodeBuddy OAuth login URL");
  });

  test("refresh uses the fixed regional endpoint and rotates the refresh token", async () => {
    let requestUrl = "";
    let authorization = "";
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return json({ code: 0, data: { accessToken: "access-2", refreshToken: "refresh-2", expiresIn: 3600 } });
    }) as typeof fetch;

    const credentials = await refreshCodeBuddyOAuth("codebuddy-oauth-global", "refresh-1");
    expect(requestUrl).toBe("https://www.codebuddy.ai/v2/plugin/auth/token/refresh");
    expect(authorization).toBe("Bearer refresh-1");
    expect(credentials).toMatchObject({ access: "access-2", refresh: "refresh-2" });
  });

  test("refresh retains the prior token when the provider omits rotation", async () => {
    globalThis.fetch = (async () => json({ code: 0, data: { accessToken: "access-2" } })) as typeof fetch;
    await expect(refreshCodeBuddyOAuth("codebuddy-oauth", "refresh-1")).resolves.toMatchObject({ access: "access-2", refresh: "refresh-1" });
  });
});
