import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { compileDisabledModels } from "@oh-my-pi/pi-coding-agent/config/disabled-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	filterAvailableModelsByEnabledPatterns,
	resolveAllowedModels,
	resolveCliModel,
	resolveModelRoleValue,
	resolveRoleChain,
	resolveRoleSelection,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function bundled(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

const mini = bundled("openai", "gpt-4o-mini");
const gpt4o = bundled("openai", "gpt-4o");
const sonnet = bundled("anthropic", "claude-sonnet-4-5");

const deniedMessage = (label: string, rule: string) =>
	`Model "${label}" is disabled by disabledModels rule "${rule}". Remove or narrow that rule to use it.`;

describe("disabledModels matcher", () => {
	it("matches exact provider/id case-insensitively and reports the rule as written", () => {
		const matcher = compileDisabledModels(["OpenAI/GPT-4o-Mini"]);
		expect(matcher(mini)).toBe("OpenAI/GPT-4o-Mini");
		expect(matcher(gpt4o)).toBeUndefined();
	});

	it("matches explicit globs against provider/id and the bare id", () => {
		expect(compileDisabledModels(["openai/*"])(gpt4o)).toBe("openai/*");
		expect(compileDisabledModels(["openai/*"])(sonnet)).toBeUndefined();
		expect(compileDisabledModels(["*-mini"])(mini)).toBe("*-mini");
		expect(compileDisabledModels(["*-mini"])(gpt4o)).toBeUndefined();
	});

	it("ignores a rule's thinking suffix so the whole model is denied", () => {
		expect(compileDisabledModels(["openai/gpt-4o-mini:high"])(mini)).toBe("openai/gpt-4o-mini:high");
		expect(compileDisabledModels(["openai/gpt-4o-mini:max"])(mini)).toBe("openai/gpt-4o-mini:max");
	});

	it("never matches bare-id, substring, or role-alias rules", () => {
		const matcher = compileDisabledModels(["gpt-4o-mini", "gpt-4o", "@default", "openai/gpt-4"]);
		expect(matcher(mini)).toBeUndefined();
		expect(matcher(gpt4o)).toBeUndefined();
	});

	it("denies an OpenRouter routing variant through its base model", () => {
		const matcher = compileDisabledModels(["openrouter/anthropic/claude-sonnet-4"]);
		expect(matcher({ provider: "openrouter", id: "anthropic/claude-sonnet-4:floor" })).toBe(
			"openrouter/anthropic/claude-sonnet-4",
		);
		expect(matcher({ provider: "openrouter", id: "anthropic/claude-sonnet-4.5" })).toBeUndefined();
	});
});

describe("disabledModels resolution", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-disabled-models-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	const registryFor = (settings: Settings) =>
		new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
	const ids = (models: readonly Model<Api>[]) => models.map(model => `${model.provider}/${model.id}`);

	it("leaves every listing and lookup unchanged when disabledModels is empty", async () => {
		const plain = registryFor(Settings.isolated({}));
		const empty = registryFor(Settings.isolated({ disabledModels: [] }));
		expect(ids(empty.getAvailable())).toEqual(ids(plain.getAvailable()));
		expect(empty.find("openai", mini.id)?.id).toBe(mini.id);
		expect(await empty.getApiKey(mini)).toBe("test-key");
	});

	it("leaves enabledModels resolution unchanged when disabledModels is empty or omitted", async () => {
		// Exact, bare (fuzzy-resolved) and role-alias allow entries.
		const allow = ["openai/gpt-4o", "gpt-4o-mini", "@smol"];
		const resolveBoth = async (overrides: Record<string, unknown>) => {
			const settings = Settings.isolated({ enabledModels: allow, ...overrides });
			settings.setModelRole("smol", "anthropic/claude-sonnet-4-5");
			const registry = registryFor(settings);
			return {
				sync: ids(filterAvailableModelsByEnabledPatterns(registry.getAvailable(), allow, settings)).sort(),
				async: ids(await resolveAllowedModels(registry, settings)).sort(),
			};
		};
		const omitted = await resolveBoth({});
		expect(omitted.sync).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o", "openai/gpt-4o-mini"]);
		expect(omitted.async).toEqual(omitted.sync);
		expect(await resolveBoth({ disabledModels: [] })).toEqual(omitted);
	});

	it("subtracts denied models after the enabledModels allow-list (deny wins) on both resolution paths", async () => {
		const settings = Settings.isolated({
			enabledModels: ["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
			disabledModels: ["openai/gpt-4o-mini"],
		});
		const registry = registryFor(settings);
		const effective = filterAvailableModelsByEnabledPatterns(
			registry.getAvailable(),
			cfgEnabledModels.get(settings),
			settings,
		);
		// The denied allow entry must not widen to a fuzzy sibling such as gpt-4.1-mini.
		expect(ids(effective).sort()).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
		expect(ids(await resolveAllowedModels(registry, settings)).sort()).toEqual([
			"anthropic/claude-sonnet-4-5",
			"openai/gpt-4o",
		]);
	});

	it("never offers an OpenRouter routing variant whose base or exact id is denied", () => {
		authStorage.keys.setRuntime("openrouter", "test-key");
		for (const rule of ["openrouter/anthropic/claude-sonnet-4", "openrouter/anthropic/claude-sonnet-4:floor"]) {
			const settings = Settings.isolated({
				enabledModels: ["openrouter/anthropic/claude-sonnet-4:floor"],
				disabledModels: [rule],
			});
			const effective = filterAvailableModelsByEnabledPatterns(
				registryFor(settings).getAvailable(),
				cfgEnabledModels.get(settings),
				settings,
			);
			expect(ids(effective)).toEqual([]);
		}
	});

	it("gives a denied model neither a lookup nor a credential, while the provider keeps working", async () => {
		const registry = registryFor(Settings.isolated({ disabledModels: ["openai/gpt-4o-mini"] }));
		expect(registry.find("openai", mini.id)).toBeUndefined();
		expect(await registry.getApiKey(mini)).toBeUndefined();
		expect(await registry.getApiKey(gpt4o)).toBe("test-key");
		expect(await registry.getApiKeyForProvider("openai")).toBe("test-key");
		// The request resolver refuses outright, so providers that allow a missing key cannot dispatch.
		expect(() => registry.resolver(mini)({ attempt: 0 } as never)).toThrow(
			deniedMessage("openai/gpt-4o-mini", "openai/gpt-4o-mini"),
		);
	});

	it("applies a path-scoped entry only at or below its path", () => {
		const scoped = (cwdPrefix: string) =>
			registryFor(Settings.isolated({ disabledModels: [{ path: cwdPrefix, models: ["openai/gpt-4o-mini"] }] }));
		expect(ids(scoped(process.cwd()).getAvailable())).not.toContain("openai/gpt-4o-mini");
		expect(ids(scoped(tempDir.join("elsewhere")).getAvailable())).toContain("openai/gpt-4o-mini");
	});

	it("applies the session's rules even when the registry was built without them", () => {
		const settings = Settings.isolated({ disabledModels: ["anthropic/*"] });
		const available = registryFor(Settings.isolated({})).getAvailable();
		expect(ids(filterAvailableModelsByEnabledPatterns(available, [], settings))).not.toContain(
			"anthropic/claude-sonnet-4-5",
		);
		const resolved = resolveModelRoleValue("claude-sonnet-4-5", available, { settings });
		expect(resolved.model).toBeUndefined();
		expect(resolved.disabledModel?.rule).toBe("anthropic/*");
	});

	it("refuses --model on a denied model, naming the rule, including thinking and --provider variants", () => {
		const settings = Settings.isolated({ disabledModels: ["openai/*-mini"] });
		const registry = registryFor(settings);
		for (const cliModel of ["openai/gpt-4o-mini", "openai/gpt-4o-mini:high"]) {
			const result = resolveCliModel({ cliModel, modelRegistry: registry, settings });
			expect(result.model).toBeUndefined();
			expect(result.error).toBe(deniedMessage("openai/gpt-4o-mini", "openai/*-mini"));
		}
		const viaProvider = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o-mini",
			modelRegistry: registry,
			settings,
		});
		expect(viaProvider.error).toBe(deniedMessage("openai/gpt-4o-mini", "openai/*-mini"));
		const allowed = resolveCliModel({ cliModel: "openai/gpt-4o", modelRegistry: registry, settings });
		expect(allowed.model?.id).toBe("gpt-4o");
	});

	it("refuses a bare --model naming a denied model instead of fuzzy-matching an allowed sibling", () => {
		const settings = Settings.isolated({ disabledModels: ["openai/gpt-4o"] });
		const registry = registryFor(settings);
		const bare = resolveCliModel({ cliModel: "gpt-4o", modelRegistry: registry, settings });
		expect(bare.model).toBeUndefined();
		expect(bare.error).toBe(deniedMessage("gpt-4o", "openai/gpt-4o"));
		// The qualified sibling stays selectable.
		const sibling = resolveCliModel({ cliModel: "openai/gpt-4o-mini", modelRegistry: registry, settings });
		expect(sibling.model?.id).toBe("gpt-4o-mini");
	});

	it("refuses a --model that resolves to a session-denied model the registry still lists", () => {
		// The registry carries no rules, so the selector text alone does not reveal the denial:
		// the resolved model is checked against the session settings.
		const settings = Settings.isolated({ disabledModels: ["anthropic/claude-sonnet-4-5"] });
		const result = resolveCliModel({
			cliModel: "claude-sonnet-4-5",
			modelRegistry: registryFor(Settings.isolated({})),
			settings,
		});
		expect(result.model).toBeUndefined();
		expect(result.error).toBe(deniedMessage("anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"));
	});

	it("refuses a role that resolves only to denied models instead of substituting a sibling", () => {
		const settings = Settings.isolated({ disabledModels: ["openai/gpt-4o-mini"] });
		const available = registryFor(settings).getAvailable();
		for (const roleValue of ["openai/gpt-4o-mini", "gpt-4o-mini"]) {
			const resolved = resolveModelRoleValue(roleValue, available, { settings });
			expect(resolved.model).toBeUndefined();
			expect(resolved.disabledModel?.rule).toBe("openai/gpt-4o-mini");
			expect(resolved.warning).toContain('disabledModels rule "openai/gpt-4o-mini"');
		}
	});

	it("resolves a bare role to the allowed provider when the session denies the preferred one", () => {
		// Both providers carry the same id; preference picks `openai` first, but the session denies it.
		const copilot = { ...mini, provider: "github-copilot" } as Model<Api>;
		const settings = Settings.isolated({
			modelProviderOrder: ["openai", "github-copilot"],
			disabledModels: ["openai/gpt-4o-mini"],
		});
		const resolved = resolveModelRoleValue("gpt-4o-mini", [mini, copilot], { settings });
		expect(resolved.model?.provider).toBe("github-copilot");
		expect(resolved.disabledModel).toBeUndefined();
	});

	it("skips a denied pattern within one role value and uses the next one", () => {
		const settings = Settings.isolated({ disabledModels: ["openai/gpt-4o-mini"] });
		const available = registryFor(settings).getAvailable();
		const resolved = resolveModelRoleValue("openai/gpt-4o-mini,anthropic/claude-sonnet-4-5", available, { settings });
		expect(resolved.model?.id).toBe(sonnet.id);
		expect(resolved.disabledModel).toBeUndefined();
	});

	it("refuses a configured modelRoles.default named on the CLI, naming the rule", () => {
		const settings = Settings.isolated({
			disabledModels: ["openai/gpt-4o-mini"],
			modelRoles: { default: "openai/gpt-4o-mini" },
		});
		const result = resolveCliModel({ cliModel: "default", modelRegistry: registryFor(settings), settings });
		expect(result.model).toBeUndefined();
		expect(result.error).toBe(deniedMessage("openai/gpt-4o-mini", "openai/gpt-4o-mini"));
	});

	it("stops a role walk at a configured role that names only denied models", () => {
		const settings = Settings.isolated({
			disabledModels: ["openai/gpt-4o-mini"],
			modelRoles: { commit: "openai/gpt-4o-mini", smol: "anthropic/claude-sonnet-4-5" },
			"retry.fallbackChains": { commit: ["anthropic/claude-sonnet-4-5"] },
		});
		const available = registryFor(settings).getAvailable();
		// Neither the role's own fallback chain nor a later role stands in for it.
		expect(resolveRoleChain("commit", settings, available)).toEqual([]);
		expect(resolveRoleSelection(["commit", "smol"], settings, available)).toBeUndefined();
		// An unconfigured role is not a choice the user made, so the walk continues.
		expect(resolveRoleSelection(["slow", "smol"], settings, available)?.model.id).toBe(sonnet.id);
	});
});
