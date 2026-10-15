import { describe, expect, it } from "vitest";

import { modelGroups, providerOfModel, type ProviderModels } from "./models-api";

const provider = (id: string, key: ProviderModels["key"], prefixes: string[], models: string[]) =>
  ({ id, name: id.toUpperCase(), key, prefixes, models, recommended: models.slice(0, 1) }) as ProviderModels;

const providers = [
  provider("openai", "server", ["gpt-", "o3"], ["gpt-6-sol", "gpt-6-luna", "o3"]),
  provider("anthropic", "none", ["claude-"], ["claude-sonnet-5"]),
  provider("mock", "not_needed", ["mock/"], ["mock/echo", "mock/tools"]),
];

describe("providerOfModel", () => {
  it("finds the provider by prefix or by a provider/ qualifier", () => {
    expect(providerOfModel("gpt-6-sol", providers)?.id).toBe("openai");
    expect(providerOfModel(" claude-x ", providers)?.id).toBe("anthropic");
    expect(providerOfModel("anthropic/claude-x", providers)?.id).toBe("anthropic");
    expect(providerOfModel("mock/echo", providers)?.id).toBe("mock");
    expect(providerOfModel("mistral-large", providers)).toBeUndefined();
    expect(providerOfModel("bedrock/x", providers)).toBeUndefined();
  });
});

describe("modelGroups", () => {
  it("offers the providers that can be used, filtered by the query", () => {
    expect(modelGroups(providers).map((g) => g.value)).toEqual(["OPENAI", "MOCK"]); // no key → left out
    expect(modelGroups(providers, "LUNA")).toMatchObject([{ value: "OPENAI", items: ["gpt-6-luna"] }]);
    expect(modelGroups(providers, "nothing")).toEqual([]);
  });
});
