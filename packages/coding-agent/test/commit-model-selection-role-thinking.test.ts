import { describe, expect, it } from "bun:test";
import { Effort } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { resolvePrimaryModel, resolveSmolModel } from "@pk-nerdsaver-ai/pi-coding-agent/commit/model-selection";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(modelRoles: Record<string, string>, modelRoleTiers?: Record<string, string>) {
	return {
		getModelRole(role: string) {
			return modelRoles[role];
		},
		getModelRoleTiers() {
			return modelRoleTiers ?? {};
		},
		getStorage() {
			return undefined;
		},
		setModelRole(role: string, value: string) {
			modelRoles[role] = value;
		},
		get(path: string) {
			if (path === "modelRoles") return modelRoles;
			if (path === "modelRoleTiers") return modelRoleTiers ?? {};
			return undefined;
		},
	} as never;
}

function createRegistry(models: ReturnType<typeof getBundledModel>[]) {
	return {
		getAvailable: () => models.filter(model => model != null),
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		authStorage: { rotateSessionCredential: async () => false as const },
		resolver: () => async () => "test-key",
	};
}

describe("commit role thinking selection", () => {
	it("returns explicit thinking for commit and smol roles, including alias overrides", async () => {
		const defaultModel = getModelOrThrow("claude-sonnet-4-5");
		const commitModel = getModelOrThrow("claude-opus-4-5");
		const settings = createSettings({
			default: `${defaultModel.provider}/${defaultModel.id}:high`,
			commit: `${commitModel.provider}/${commitModel.id}:low`,
			smol: "pi/default:minimal",
		});
		const registry = {
			getAvailable: () => [defaultModel, commitModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const primary = await resolvePrimaryModel(undefined, settings, registry);
		expect(primary.model.id).toBe(commitModel.id);
		expect(primary.thinkingLevel).toBe(Effort.Low);

		const smol = await resolveSmolModel(settings, registry, commitModel, "fallback-key");
		expect(smol.model.id).toBe(defaultModel.id);
		expect(smol.thinkingLevel).toBe(Effort.Minimal);
	});
});

describe("commit smol service tiers", () => {
	it("applies the smol tier on the role-selection path", async () => {
		const sonnet = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({ smol: "anthropic/claude-sonnet-4-5" }, { smol: "priority" });
		const smol = await resolveSmolModel(settings, createRegistry([sonnet]), sonnet, "fallback-key");
		expect(smol.model.id).toBe(sonnet.id);
		expect(smol.serviceTier).toBe("priority");
		expect(smol.serviceTierExplicit).toBe(true);
	});

	it("applies the smol tier on the MODEL_PRIO fallback path", async () => {
		const sonnet = getModelOrThrow("claude-sonnet-4-5");
		const haiku = getBundledModel("anthropic", "claude-haiku-4-5") ?? getModelOrThrow("claude-3-5-haiku-20241022");
		const settings = createSettings({}, { smol: "priority" });
		const smol = await resolveSmolModel(settings, createRegistry([sonnet, haiku]), sonnet, "fallback-key");
		expect(smol.model.id).toContain("haiku");
		expect(smol.serviceTier).toBe("priority");
		expect(smol.serviceTierExplicit).toBe(true);
	});

	it("applies the smol tier on the primary-model fallback path", async () => {
		const sonnet = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({}, { smol: "flex" });
		const smol = await resolveSmolModel(settings, createRegistry([sonnet]), sonnet, "fallback-key");
		expect(smol.model.id).toBe(sonnet.id);
		expect(smol.serviceTier).toBe("flex");
		expect(smol.serviceTierExplicit).toBe(true);
	});

	it("marks an explicit 'none' entry so consumers clear the ambient tier", async () => {
		const sonnet = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({ smol: "anthropic/claude-sonnet-4-5" }, { smol: "none" });
		const smol = await resolveSmolModel(settings, createRegistry([sonnet]), sonnet, "fallback-key");
		expect(smol.serviceTier).toBeUndefined();
		expect(smol.serviceTierExplicit).toBe(true);
	});

	it("leaves the tier absent and non-explicit when nothing is configured", async () => {
		const sonnet = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({ smol: "anthropic/claude-sonnet-4-5" });
		const smol = await resolveSmolModel(settings, createRegistry([sonnet]), sonnet, "fallback-key");
		expect(smol.serviceTier).toBeUndefined();
		expect(smol.serviceTierExplicit).toBeFalsy();
	});
});
