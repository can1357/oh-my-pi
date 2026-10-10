import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import { gatewayModels } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-models";
import { selectorCandidates } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const fast = getBundledModel("google", "gemini-2.5-flash")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const vertex = getBundledModel("google-vertex", "gemini-2.5-flash")!;
const models = [fast, mini, vertex];
// Mirrors ModelRegistry: lookups are kind-scoped and default to chat.
const chatOnly = (kind: ModelKind | "all" = "chat") => (kind === "chat" || kind === "all" ? models : []);
const registry = { getAll: chatOnly, getAvailable: chatOnly };
const key = (model: typeof fast) => `${model.provider}/${model.id}`;

describe("auth-gateway stdio model selectors", () => {
	it("skips comma entries that resolve to nothing and follows the chosen role's fallback chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex), key(fast)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@commit,@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("follows a concrete model's own chain and stops at the first resolvable entry", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(mini)]: [key(vertex)] } });
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([mini, vertex]);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorCandidates("@commit", Settings.isolated({}), registry)).toEqual([]);
	});

	it("resolves judge selectors for /v1/systemone and lists judge models (#15227)", async () => {
		const storage = await AuthStorage.create(":memory:");
		try {
			await storage.credentials.set("typesafe", { type: "api_key", key: "ts-test" });
			const settings = Settings.isolated({});
			settings.setModelRole("judge", "typesafe/jev-latest");
			const registry = new ModelRegistry(storage, undefined, { ignoreLocalModelConfig: true, settings });

			const [judgeRole] = selectorCandidates("@judge", settings, registry);
			const [explicit] = selectorCandidates("typesafe/jev-latest", settings, registry);
			expect(judgeRole && key(judgeRole)).toBe("typesafe/jev-latest");
			expect(explicit && key(explicit)).toBe("typesafe/jev-latest");
			// `/v1/models` on stdio lists the same set.
			expect(
				gatewayModels(registry)
					.getAvailable()
					.some(model => key(model) === "typesafe/jev-latest"),
			).toBe(true);
		} finally {
			storage.close();
		}
	});
});
