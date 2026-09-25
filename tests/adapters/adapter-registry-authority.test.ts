import { describe, expect, test } from "bun:test";
import {
  adapterDefinitions,
  createRegisteredAdapter,
  effectiveAdapterContract,
  getAdapterDefinition,
} from "../../src/adapters/registry";
import { resolveAdapter } from "../../src/server/adapter-resolve";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const EXPECTED_ADAPTER_NAMES = {
  codebuddy: "codebuddy",
  "codebuddy-oauth": "codebuddy-oauth",
  "command-code": "command-code",
  "openai-chat": "openai-chat",
  "ollama-native": "ollama-native",
  anthropic: "anthropic",
  "openai-responses": "openai-responses",
  google: "google",
  kiro: "kiro",
  azure: "azure-openai",
  "azure-openai": "azure-openai",
  cursor: "cursor",
  devin: "devin",
  "mimo-free": "mimo-free",
  qoder: "qoder",
  "claude-cli": "claude-cli",
} as const;

function provider(adapter: string): OcxProviderConfig {
  return {
    adapter,
    // mimo-free throws for non-canonical endpoints since #1714; every other
    // adapter accepts the placeholder URL.
    baseUrl: adapter === "mimo-free"
      ? "https://api.xiaomimimo.com/api/free-ai/openai/chat"
      : adapter === "codebuddy"
        ? "https://www.codebuddy.ai"
        : adapter === "codebuddy-oauth"
          ? "https://copilot.tencent.com"
        : adapter === "qoder"
          ? "https://qoder.com"
        // ollama-native refuses a bare /v1 path on a host it does not recognise, rather than
        // guessing that an arbitrary destination speaks Ollama's compatibility surface.
        : adapter === "ollama-native"
          ? "https://example.invalid/api"
          : "https://example.invalid/v1",
    authMode: "key",
    apiKey: "test-key",
    defaultMaxOutputTokens: 4096,
  } as OcxProviderConfig;
}

const ANTHROPIC_CACHE_REQUEST: OcxParsedRequest = {
  modelId: "claude-haiku-4-5",
  stream: true,
  options: {},
  context: {
    messages: [{ role: "user", content: "cache me", timestamp: 0 }],
  },
};

async function expectLongCacheRetention(adapter: ReturnType<typeof resolveAdapter>): Promise<void> {
  const request = await withTestTranslatorBudget(adapter).buildRequest(ANTHROPIC_CACHE_REQUEST);
  const body = JSON.parse(request.body) as {
    messages?: Array<{ content?: string | Array<{ cache_control?: { type?: string; ttl?: string } }> }>;
  };
  const content = body.messages?.[0]?.content;
  if (!Array.isArray(content)) throw new Error("expected Anthropic cache retention to annotate user content");
  expect(content.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
}

describe("adapter registry authority", () => {
  test("enumerates every production adapter exactly once", () => {
    expect(adapterDefinitions().map(([id]) => id)).toEqual(Object.keys(EXPECTED_ADAPTER_NAMES));
  });

  test("records semantic inheritance without forcing constructor wrapping", () => {
    expect(getAdapterDefinition("azure")?.contractParent).toBe("openai-responses");
    expect(getAdapterDefinition("azure-openai")?.contractParent).toBe("openai-responses");
    expect(getAdapterDefinition("mimo-free")?.contractParent).toBe("openai-chat");

    expect(effectiveAdapterContract("azure").wire).toBe("openai-responses");
    expect(effectiveAdapterContract("azure-openai").wire).toBe("openai-responses");
    expect(effectiveAdapterContract("mimo-free").wire).toBe("openai-chat");
    expect(effectiveAdapterContract("codebuddy-oauth").wire).toBe("openai-chat");
    expect(effectiveAdapterContract("cursor").mutation).toBe("codex-owned-with-gated-native-fallback");
  });

  test("constructs every current adapter with its existing observable identity", () => {
    for (const [adapterId, expectedName] of Object.entries(EXPECTED_ADAPTER_NAMES)) {
      expect(createRegisteredAdapter(provider(adapterId)).name, adapterId).toBe(expectedName);
      expect(resolveAdapter(provider(adapterId)).name, adapterId).toBe(expectedName);
    }
  });

  test("CodeBuddy OAuth is registry-constructible without context and pins bearer destinations by region", async () => {
    const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ user_id: "u1", tenant_id: "t1" })).toString("base64url")}.x`;
    const cnConfig = {
      ...provider("codebuddy-oauth"), authMode: "oauth" as const, apiKey: token,
      baseUrl: "https://attacker.invalid", headers: { Authorization: "Bearer attacker", "X-Domain": "wrong" },
    };
    expect(createRegisteredAdapter(provider("codebuddy-oauth")).name).toBe("codebuddy-oauth");
    const adapter = createRegisteredAdapter(cnConfig, { providerId: "codebuddy-oauth" });
    const request = await withTestTranslatorBudget(adapter).buildRequest(ANTHROPIC_CACHE_REQUEST);
    expect(request.url).toBe("https://copilot.tencent.com/v2/chat/completions");
    expect(request.headers.Authorization).toBe(`Bearer ${token}`);
    expect(request.headers["X-Domain"]).toBe("www.codebuddy.cn");
    expect(request.headers["X-Tenant-Id"]).toBe("t1");
    expect(request.headers["X-IDE-Name"]).toBe("VSCode");
    expect(request.headers["X-Product-Version"]).toBe("4.9.29177644");
    expect(request.headers["X-Env-ID"]).toBe("production");
    expect(request.headers["X-IDE-Plugin-Version"]).toBeUndefined();
    expect(() => createRegisteredAdapter({ ...cnConfig, baseUrl: "https://www.codebuddy.ai" }, { providerId: "codebuddy-oauth" }))
      .toThrow("CodeBuddy OAuth region mismatch");
  });

  test("forwards Anthropic cache retention through registry and server resolution", async () => {
    await expectLongCacheRetention(createRegisteredAdapter(provider("anthropic"), { cacheRetention: "long" }));
    await expectLongCacheRetention(resolveAdapter(provider("anthropic"), "long"));
  });

  test("rejects unknown persisted adapter ids at the runtime boundary", () => {
    for (const adapterId of ["not-a-real-adapter", "__proto__", "constructor"]) {
      expect(() => createRegisteredAdapter(provider(adapterId)))
        .toThrow(`Unknown adapter: ${adapterId}`);
      expect(() => effectiveAdapterContract(adapterId))
        .toThrow(`Unknown adapter: ${adapterId}`);
    }
  });

  test("rejects non-string persisted adapter ids before registry lookup", () => {
    for (const adapterId of [null, 42, ["azure"]]) {
      expect(getAdapterDefinition(adapterId)).toBeUndefined();
      const malformed = { ...provider("anthropic"), adapter: adapterId } as unknown as OcxProviderConfig;
      expect(() => createRegisteredAdapter(malformed)).toThrow("Unknown adapter:");
    }
  });
});
