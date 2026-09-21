import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import ComboWorkspace from "../src/components/ComboWorkspace";
import { TargetEditor } from "../src/components/combo-workspace-controls";
import ProviderDetails from "../src/components/provider-workspace/ProviderDetails";
import { LanguageProvider } from "../src/i18n/provider";
import Combos from "../src/pages/Combos";
import { navigateHash } from "../src/hash-routing";
import { readModelsTab } from "../src/pages/models-tab";
import { toPutBody, type ComboItem } from "../src/combo-workspace-data";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let testWindow: Window;
let root: Root | null;

const models = [
  { provider: "native-only", id: "gpt-6-astra", reasoningEfforts: ["medium"] },
  { provider: "native-only", id: "gpt-5.6-sol", reasoningEfforts: ["medium"] },
  { provider: "native-only", id: "gpt-5.6-luna", reasoningEfforts: ["medium"] },
  { provider: "openai", id: "gpt-6-astra", reasoningEfforts: ["medium", "high", "xhigh"] },
  { provider: "openai", id: "gpt-5.6-sol", reasoningEfforts: ["low", "medium", "high"] },
  { provider: "openai", id: "gpt-5.6-luna", reasoningEfforts: ["low", "medium"] },
  { provider: "anthropic", id: "claude-sonnet-5", reasoningEfforts: ["low", "medium", "high"] },
];

const existing: ComboItem = {
  id: "fallback",
  model: "combo/fallback",
  alias: null,
  nativeAlias: false,
  displayName: null,
  strategy: "failover",
  stickyLimit: 1,
  defaultEffort: null,
  targets: [{ provider: "openai", model: "gpt-5.6-luna" }],
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/#providers/jev" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flush(rounds = 3) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
}

function setSelect(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
    .set!.call(select, value);
  select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
}

test("Combo workspace exposes JEV Auto and reports an existing selector collision", () => {
  const markup = renderToStaticMarkup(
    <LanguageProvider>
      <ComboWorkspace
        combos={[existing]}
        providerQuotaStates={{}}
        providers={[{ name: "openai" }]}
        models={models}
        loading={false}
        onRefresh={() => {}}
        onSave={async () => ({ ok: true })}
        onRemove={async () => ({ ok: true })}
        onAdd={() => {}}
        adding={false}
        onCloseAdd={() => {}}
        onCreated={() => {}}
      />
    </LanguageProvider>,
  );
  expect(markup).toContain("Create JEV Auto");

  const collision = renderToStaticMarkup(
    <LanguageProvider>
      <ComboWorkspace
        combos={[{ ...existing, id: "jev-auto", model: "jev-auto", alias: "jev-auto", strategy: "jev" }]}
        providerQuotaStates={{}}
        providers={[{ name: "openai" }]}
        models={models}
        loading={false}
        onRefresh={() => {}}
        onSave={async () => ({ ok: true })}
        onRemove={async () => ({ ok: true })}
        onAdd={() => {}}
        adding={false}
        onCloseAdd={() => {}}
        onCreated={() => {}}
      />
    </LanguageProvider>,
  );
  expect(collision).toContain("JEV Auto already exists");
  expect(collision).toMatch(/disabled=""[^>]*>[^<]*Create JEV Auto|Create JEV Auto[^<]*<\/button>/);
});

test("JEV fail-open badge skips quota-exhausted targets", () => {
  const markup = renderToStaticMarkup(
    <LanguageProvider>
      <TargetEditor
        targets={[
          { provider: "openai", model: "gpt-6-astra", clientKey: "first" },
          { provider: "anthropic", model: "claude-sonnet-5", clientKey: "second" },
        ]}
        strategy="jev"
        providers={[{ name: "openai" }, { name: "anthropic" }]}
        models={models}
        providerQuotaStates={{ openai: "exhausted", anthropic: "available" }}
        onChange={() => {}}
      />
    </LanguageProvider>,
  );
  const host = document.createElement("div");
  host.innerHTML = markup;
  const entries = host.querySelectorAll(".cwi-target-entry");

  expect(entries).toHaveLength(2);
  expect(entries[0]!.querySelector(".chip")).toBeNull();
  expect(entries[1]!.querySelector(".chip")?.textContent).toBe("Fail-open target");
});

test("configured JEV deep-link opens the shared editable Combo modal and submits the normal PUT", async () => {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ProviderDetails
          item={{
            name: "jev",
            adapter: "jev-decision",
            baseUrl: "https://api.typesafe.ai/v1/systemone",
            authMode: "key",
            hasApiKey: true,
          }}
          availableModels={[]}
          hasLiveModels={false}
          selectedModels={[]}
          modelRows={[]}
          modelRevision="jev-test"
          modelRowsReady
          onOpenModels={() => {}}
          onCreateJevAuto={() => navigateHash("models/combos/jev-auto")}
          onDeselect={() => {}}
          apiBase=""
        />
      </LanguageProvider>,
    );
  });
  const providerAction = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "Create JEV Auto");
  expect(providerAction).toBeDefined();
  await act(async () => { providerAction!.click(); });
  expect(window.location.hash).toBe("#models/combos/jev-auto");
  expect(readModelsTab()).toBe("combos");

  await act(async () => { root!.unmount(); });
  root = createRoot(host);

  const puts: unknown[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/combos") && init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return Response.json({ success: true });
      }
      if (url.endsWith("/api/combos")) return Response.json({ combos: [existing] });
      if (url.endsWith("/api/config")) {
        return Response.json({
          providers: {
            openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1" },
            anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com" },
            jev: { adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone" },
          },
        });
      }
      if (url.endsWith("/api/models")) return Response.json(models);
      if (url.endsWith("/api/provider-quotas")) return Response.json({ reports: [] });
      throw new Error(`unexpected request: ${url}`);
    },
  });

  await act(async () => {
    root!.render(<LanguageProvider><Combos apiBase="" /></LanguageProvider>);
  });
  await flush(6);

  const dialog = host.querySelector<HTMLDialogElement>('dialog[data-combo-preset="jev-auto"]');
  expect(dialog).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>("#cwi-new-id")?.value).toBe("jev-auto");
  expect(host.querySelector<HTMLInputElement>("#cwi-new-alias")?.value).toBe("jev-auto");
  expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("JEV");
  expect(host.textContent).toContain("Fail-open target");
  expect(host.textContent).toContain("medium, high, xhigh");
  expect([...dialog!.querySelectorAll<HTMLSelectElement>('select[aria-label="Provider"]')]
    .map(select => select.value)).toEqual(["openai", "openai", "openai"]);

  const addTarget = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "Add target")!;
  await act(async () => { addTarget.click(); });
  let targetRows = host.querySelectorAll<HTMLElement>(".cwi-target-row");
  expect(targetRows).toHaveLength(4);
  await act(async () => {
    setSelect(targetRows[3]!.querySelectorAll("select")[0]!, "anthropic");
  });
  expect(targetRows[3]!.querySelectorAll("select")[1]!.value).toBe("claude-sonnet-5");

  const removeButtons = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove"]');
  await act(async () => { removeButtons[2]!.click(); });
  targetRows = host.querySelectorAll<HTMLElement>(".cwi-target-row");
  expect(targetRows).toHaveLength(3);

  const create = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "Create combo")!;
  await act(async () => { create.click(); });
  await flush();

  expect(puts).toEqual([toPutBody({
    id: "jev-auto",
    model: "jev-auto",
    alias: "jev-auto",
    nativeAlias: false,
    displayName: null,
    strategy: "jev",
    stickyLimit: 1,
    defaultEffort: null,
    imageInput: "auto",
    reasoningEffortMode: "adaptive",
    targets: [
      { provider: "openai", model: "gpt-6-astra" },
      { provider: "openai", model: "gpt-5.6-sol" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ],
  })]);
});
