import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { factoryDroidRegistry } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { getModelMatchPreferences, parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import {
	assertPerCallModelApproved,
	getPerCallModelAdvertisement,
	parentModelGrantPattern,
	PerCallModelError,
	type PerCallModelGrants,
} from "@oh-my-pi/pi-coding-agent/task/model-approval";
import { cfgTaskPerCallModelAllow, perCallModelEnabled } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const target = createMockModel({ id: "target" });
const other = createMockModel({ id: "other" });
const bracketed = createMockModel({ id: "glm[1m]" });
const bracketImposter = createMockModel({ id: "glm1" });
const wildcardLiteral = createMockModel({ id: "target*" });
const image = { ...createMockModel({ id: "painter" }), kind: "image" as const };
const routerModel = (provider: string, id: string, baseUrl: string) =>
	buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
const sonnet = routerModel("openrouter", "anthropic/claude-sonnet-4.5", "https://openrouter.ai/api/v1");
const pinnedSonnet = parseModelPattern("openrouter/anthropic/claude-sonnet-4.5@anthropic", [sonnet]).model!;
// Separate catalog models: the base costs 8x the `:low` variant's input price.
const codingRouter = routerModel("nanogpt", "nanogpt/coding-router", "https://nano-gpt.com/api/v1");
const codingRouterLow = routerModel("nanogpt", "nanogpt/coding-router:low", "https://nano-gpt.com/api/v1");
const droidFable = buildModel(
	buildFactoryDroidModel(
		factoryDroidRegistry().find(entry => entry.spec.id === "claude-fable-5")!,
		{ apiProviders: ["anthropic"] },
	),
);
const chat = [
	target,
	other,
	bracketed,
	bracketImposter,
	wildcardLiteral,
	sonnet,
	codingRouter,
	codingRouterLow,
	droidFable,
];
const registry = {
	getAll: () => [...chat, image],
	getAvailable: (kind?: string) => (kind === "chat" ? chat : [...chat, image]),
};

function approved(
	model: Model,
	grants: PerCallModelGrants,
	modelRegistry: Parameters<typeof assertPerCallModelApproved>[2] = registry,
): boolean {
	try {
		assertPerCallModelApproved(model, grants, modelRegistry);
		return true;
	} catch (error) {
		if (!(error instanceof PerCallModelError)) throw error;
		return false;
	}
}

interface Row {
	name: string;
	settings?: Record<string, unknown>;
	agentSource?: AgentSource;
	agentModel?: string[];
	agentRemoved?: boolean;
	parentModelPattern?: string;
	model?: Model;
	unavailable?: Model;
	/** Settings injected by a subagent overlay on top of `settings`. */
	overlay?: Record<string, unknown>;
	approved: boolean;
}

const rows: Row[] = [
	{ name: "nothing configured", approved: false },
	{ name: "configured chat role value", settings: { modelRoles: { review: "mock/target" } }, approved: true },
	{ name: "role value with a level", settings: { modelRoles: { review: "mock/target:high" } }, approved: true },
	{
		name: "one candidate of a role list",
		settings: { modelRoles: { review: "mock/other,mock/target" } },
		approved: true,
	},
	// Globs route a role but never grant: the operator must name each per-call model.
	{ name: "a provider glob role value", settings: { modelRoles: { review: "mock/*" } }, approved: false },
	{ name: "a bare-id glob role value", settings: { modelRoles: { review: "tar?et" } }, approved: false },
	{ name: "a glob agent frontmatter model", agentSource: "bundled", agentModel: ["mock/*"], approved: false },
	{
		name: "a mixed role keeps its concrete grant without broadening through its glob",
		settings: { modelRoles: { review: "mock/*, mock/other" } },
		approved: false,
	},
	{
		name: "a mixed frontmatter value keeps its concrete grant",
		agentSource: "bundled",
		agentModel: ["mock/*", "mock/target"],
		approved: true,
	},
	{
		name: "a catalog literal containing a wildcard is never a role grant",
		settings: { modelRoles: { review: "mock/target*" } },
		model: wildcardLiteral,
		approved: false,
	},
	{
		name: "a catalog literal containing a wildcard is never a frontmatter grant",
		agentSource: "user",
		agentModel: ["mock/target*"],
		model: wildcardLiteral,
		approved: false,
	},
	{ name: "non-chat role value", settings: { modelRoles: { image: "mock/target" } }, approved: false },
	{ name: "role alias is not expanded into defaults", settings: { modelRoles: { review: "@smol" } }, approved: false },
	{ name: "bare * is @default, not a glob", settings: { modelRoles: { review: "*" } }, approved: false },
	{ name: "parent's live model", parentModelPattern: "mock/target", approved: true },
	{ name: "bundled agent frontmatter", agentSource: "bundled", agentModel: ["mock/target"], approved: true },
	{ name: "user agent frontmatter", agentSource: "user", agentModel: ["mock/target"], approved: true },
	{ name: "project agent frontmatter", agentSource: "project", agentModel: ["mock/target"], approved: false },
	{
		name: "removed agent's frontmatter",
		agentSource: "user",
		agentModel: ["mock/target"],
		agentRemoved: true,
		approved: false,
	},
	{
		name: "disabled agent's frontmatter",
		settings: { "task.disabledAgents": ["worker"] },
		agentSource: "user",
		agentModel: ["mock/target"],
		approved: false,
	},
	{
		name: "agent override entry is not a grant",
		settings: { "task.agentModelOverrides": { worker: "mock/target" } },
		approved: false,
	},
	{
		name: "retry fallback chain entry is not a grant",
		settings: { modelRoles: { review: "mock/other" }, "retry.fallbackChains": { review: ["mock/target"] } },
		approved: false,
	},
	{
		name: "allowlist narrows a granted model",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/other"] },
		approved: false,
	},
	{
		name: "a scoped allowlist glob alone grants nothing",
		settings: { "task.perCallModelAllow": ["mock/*"] },
		approved: false,
	},
	{
		name: "the allowlist trims literal entries",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": [" mock/target "] },
		approved: true,
	},
	{ name: "allowlist alone grants nothing", settings: { "task.perCallModelAllow": ["mock/target"] }, approved: false },
	{
		name: "allowlist role entry admits what the role grants",
		settings: { modelRoles: { review: "mock/target", smol: "mock/other" }, "task.perCallModelAllow": ["@review"] },
		approved: true,
	},
	{
		name: "allowlist role entry excludes another role's model",
		settings: { modelRoles: { review: "mock/other", smol: "mock/target" }, "task.perCallModelAllow": ["@review"] },
		approved: false,
	},
	{
		name: "allowlist entry for an unconfigured role admits nothing",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["@smol"] },
		approved: false,
	},
	{
		name: "allowlist glob entry",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/t*"] },
		approved: true,
	},
	{
		name: "brackets in a literal id are not a glob",
		settings: { modelRoles: { review: "mock/glm[1m]" } },
		model: bracketed,
		approved: true,
	},
	{
		name: "an unavailable bracketed literal never becomes a glob",
		settings: { modelRoles: { review: "mock/glm[1m]" } },
		unavailable: bracketed,
		model: bracketImposter,
		approved: false,
	},
	{
		name: "a non-chat model never qualifies",
		settings: { modelRoles: { review: "mock/painter" } },
		model: image,
		approved: false,
	},
	{
		name: "an upstream-pinned role does not grant the unpinned model",
		settings: { modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5@anthropic" } },
		model: sonnet,
		approved: false,
	},
	{
		name: "an upstream-pinned role grants its pinned route",
		settings: { modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5@anthropic" } },
		model: pinnedSonnet,
		approved: true,
	},
	{
		name: "an unpinned role does not grant a pinned route",
		settings: { modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5" } },
		model: pinnedSonnet,
		approved: false,
	},
	{
		name: "the allowlist keeps an upstream pin",
		settings: {
			modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5" },
			"task.perCallModelAllow": ["openrouter/anthropic/claude-sonnet-4.5@anthropic"],
		},
		model: sonnet,
		approved: false,
	},
	{
		name: "a role naming a catalog id with a level-shaped suffix grants that id",
		settings: { modelRoles: { review: "nanogpt/nanogpt/coding-router:low" } },
		model: codingRouterLow,
		approved: true,
	},
	{
		name: "an unavailable literal with a level-shaped suffix never grants the base id",
		settings: { modelRoles: { review: "nanogpt/nanogpt/coding-router:low" } },
		unavailable: codingRouterLow,
		model: codingRouter,
		approved: false,
	},
	{
		name: "an unavailable bare literal with a level-shaped suffix never grants the base id",
		settings: { modelRoles: { review: "nanogpt/coding-router:low" } },
		unavailable: codingRouterLow,
		model: codingRouter,
		approved: false,
	},
	{
		name: "an allowlisted catalog id with a level-shaped suffix admits that id",
		settings: {
			modelRoles: { review: "nanogpt/nanogpt/coding-router:low" },
			"task.perCallModelAllow": ["nanogpt/nanogpt/coding-router:low"],
		},
		model: codingRouterLow,
		approved: true,
	},
	{
		name: "a configured Factory chat role grants its model like any other provider",
		settings: { modelRoles: { review: "factory-droid/claude-fable-5" } },
		model: droidFable,
		approved: true,
	},
	{
		name: "a subagent overlay's injected role never grants",
		overlay: { modelRoles: { advisor: "mock/target" } },
		approved: false,
	},
	{
		name: "a role the operator set still grants through a child overlay",
		settings: { modelRoles: { review: "mock/target" } },
		overlay: { modelRoles: { advisor: "mock/other" } },
		approved: true,
	},
	{
		name: "a subagent overlay's allowlist narrows the operator's grants",
		settings: { modelRoles: { review: "mock/target" } },
		overlay: { "task.perCallModelAllow": ["mock/other"] },
		approved: false,
	},
	{
		name: "a subagent overlay's allowlist cannot replace the operator's",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/other"] },
		overlay: { "task.perCallModelAllow": ["mock/target"] },
		approved: false,
	},
	{
		name: "a derived allowlisted role expands through operator values, not injected values",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/*"] },
		overlay: { modelRoles: { review: "mock/other" }, "task.perCallModelAllow": ["@review"] },
		approved: true,
	},
	{
		name: "operator and derived role allowlists must both admit the model",
		settings: {
			modelRoles: { review: "mock/target", smol: "mock/other" },
			"task.perCallModelAllow": ["@smol"],
		},
		overlay: { "task.perCallModelAllow": ["mock/*", "@review"] },
		approved: false,
	},
];

describe("per-call model advertisement", () => {
	it("advertises no built-in role defaults", () => {
		expect(getPerCallModelAdvertisement(Settings.isolated())).toEqual({
			roles: [],
			allowlist: [],
			parentModelWithheld: false,
		});
	});

	it.each([
		{ allowlist: [], expected: true },
		{ allowlist: ["mock/target"], expected: true },
		{ allowlist: ["mock/other"], expected: false },
	])(
		"keeps the configured default value as a grant without advertising its alias for $allowlist",
		({ allowlist, expected }) => {
			const settings = Settings.isolated({
				modelRoles: { default: "mock/target" },
				"task.perCallModelAllow": allowlist,
			});
			expect(approved(target, { settings, agentName: "worker" })).toBe(expected);
			expect(getPerCallModelAdvertisement(settings, undefined, registry).roles).toEqual([]);
		},
	);

	it("keeps configured role order and selectors while filtering and deduplicating grants", () => {
		const settings = Settings.isolated({
			modelRoles: {
				smol: "anthropic/claude-haiku-4-5",
				image: "image/provider",
				judge: "judge/provider",
				web: "web/provider",
				alias: "@smol",
				legacyAlias: "pi/slow",
				defaulted: "default",
				inherited: "inherit",
				starAlias: "*",
				slow: "unavailable/model@upstream:high",
				custom: "anthropic/*, @slow, default, mock/target, anthropic/*, inherit",
			},
			"task.perCallModelAllow": ["mock/target", " mock/target ", "unavailable/model@upstream"],
		});
		// The allowlist narrows the advertisement: a role is listed only while an entry could admit it.
		expect(getPerCallModelAdvertisement(settings)).toEqual({
			roles: [
				{ role: "slow", patterns: ["unavailable/model@upstream:high"] },
				{ role: "custom", patterns: ["mock/target"] },
			],
			allowlist: ["mock/target", "unavailable/model@upstream"],
			parentModelWithheld: false,
		});
	});

	it.each([{ allowlist: [] }, { allowlist: ["mock/target"] }])(
		"advertises a bare role as an exact selector with allowlist $allowlist",
		({ allowlist }) => {
			const settings = Settings.isolated({
				modelRoles: { review: "target" },
				"task.perCallModelAllow": allowlist,
			});
			expect(approved(target, { settings, agentName: "worker" })).toBe(true);
			expect(getPerCallModelAdvertisement(settings, undefined, registry).roles).toEqual([
				{ role: "review", patterns: ["mock/target"] },
			]);
		},
	);

	it("uses the dispatch allowlist's literal case comparison in advertisements", () => {
		const mixedCase = createMockModel({ id: "MiniMax-M2" });
		const modelRegistry = { getAll: () => [mixedCase], getAvailable: () => [mixedCase] };
		const settings = Settings.isolated({
			modelRoles: { review: "mock/MiniMax-M2" },
			"task.perCallModelAllow": ["mock/minimax-m2"],
		});
		expect(approved(mixedCase, { settings, agentName: "worker" }, modelRegistry)).toBe(false);
		expect(getPerCallModelAdvertisement(settings, undefined, modelRegistry).roles).toEqual([]);
	});

	it("withholds the own-model clause when the parent's routing cannot be written as one selector", () => {
		const settings = Settings.isolated({ modelRoles: { smol: "mock/target" } });
		const multiRoute = {
			...sonnet,
			compat: { ...sonnet.compat, openRouterRouting: { only: ["anthropic", "google-vertex"] } },
		} as Model;
		expect(getPerCallModelAdvertisement(settings, multiRoute).parentModelWithheld).toBe(true);
		expect(getPerCallModelAdvertisement(settings, sonnet).parentModelWithheld).toBe(false);
		expect(getPerCallModelAdvertisement(settings).parentModelWithheld).toBe(false);
	});

	it("withholds the own-model clause when a non-empty allowlist does not list the parent's model", () => {
		const listed = Settings.isolated({ "task.perCallModelAllow": ["openrouter/anthropic/claude-sonnet-4.5"] });
		const unlisted = Settings.isolated({ "task.perCallModelAllow": ["mock/target"] });
		expect(getPerCallModelAdvertisement(listed, sonnet).parentModelWithheld).toBe(false);
		expect(getPerCallModelAdvertisement(unlisted, sonnet).parentModelWithheld).toBe(true);
	});

	it("reads live grant authority: derived settings never grant, host overlays do", () => {
		const root = Settings.isolated({
			modelRoles: { smol: "mock/target" },
			"task.perCallModelAllow": ["mock/target"],
		});
		const child = root.overlay({ modelRoles: { slow: "mock/other" } }, { derived: true });
		expect(getPerCallModelAdvertisement(child)).toEqual(getPerCallModelAdvertisement(root));
		root.setModelRole("smol", "mock/edited");
		cfgTaskPerCallModelAllow.override(root, ["mock/edited"]);
		expect(getPerCallModelAdvertisement(child)).toEqual({
			roles: [{ role: "smol", patterns: ["mock/edited"] }],
			allowlist: ["mock/edited"],
			parentModelWithheld: false,
		});

		const host = root.overlay({
			modelRoles: { slow: "host/model" },
			"task.perCallModelAllow": ["host/model"],
		});
		expect(getPerCallModelAdvertisement(host)).toEqual({
			roles: [{ role: "slow", patterns: ["host/model"] }],
			allowlist: ["host/model"],
			parentModelWithheld: false,
		});
	});

	it("advertises only what both the operator's and a derived allowlist admit", () => {
		const root = Settings.isolated({
			modelRoles: { smol: "mock/target", slow: "mock/other" },
			"task.perCallModelAllow": ["mock/target", "mock/other"],
		});
		const child = root.overlay({ "task.perCallModelAllow": ["mock/other", "mock/extra"] }, { derived: true });
		expect(getPerCallModelAdvertisement(child)).toEqual({
			roles: [{ role: "slow", patterns: ["mock/other"] }],
			allowlist: ["mock/other"],
			parentModelWithheld: false,
		});
	});
});

describe("per-call model grants", () => {
	it.each(rows)("$name", row => {
		const grants: PerCallModelGrants = {
			settings: row.overlay
				? Settings.isolated(row.settings ?? {}).overlay(row.overlay, { derived: true })
				: Settings.isolated(row.settings ?? {}),
			agentName: "worker",
			agentSource: row.agentSource,
			agentModel: row.agentModel,
			agentRemoved: row.agentRemoved,
			parentModelPattern: row.parentModelPattern,
		};
		const available = chat.filter(model => model !== row.unavailable);
		const modelRegistry = { ...registry, getAvailable: () => available };
		expect(approved(row.model ?? target, grants, modelRegistry)).toBe(row.approved);
	});

	it.each([
		["openai/*", true],
		["openai/*:high", false],
		["@scope", true],
	] as const)("keeps the allowlist %s provider-scoped without splitting its suffix", (allow, expectedDirect) => {
		const direct = createMockModel({ provider: "openai", id: "gpt-5" });
		const routed = createMockModel({ provider: "openrouter", id: "openai/gpt-5" });
		const models = [direct, routed];
		const modelRegistry = { getAll: () => models, getAvailable: () => models };
		const settings = Settings.isolated({
			modelRoles: { review: "openrouter/openai/gpt-5", fast: "openai/gpt-5", scope: "openai/gpt-5" },
			"task.perCallModelAllow": [allow],
		});
		const grants = { settings, agentName: "worker" };
		expect(approved(routed, grants, modelRegistry)).toBe(false);
		expect(approved(direct, grants, modelRegistry)).toBe(expectedDirect);
		expect(getPerCallModelAdvertisement(settings, undefined, modelRegistry).roles).not.toContainEqual({
			role: "review",
			patterns: ["openrouter/openai/gpt-5"],
		});
	});

	it("never expands a glob-valued allowlisted role, even with an independent literal grant", () => {
		const settings = Settings.isolated({
			modelRoles: { review: "mock/target", scope: "mock/*" },
			"task.perCallModelAllow": ["@scope"],
		});
		expect(approved(target, { settings, agentName: "worker" })).toBe(false);
		expect(getPerCallModelAdvertisement(settings, undefined, registry).roles).toEqual([]);
	});

	it("keeps brackets literal in an exact allowlist", () => {
		const settings = Settings.isolated({
			modelRoles: { review: "mock/glm[1m], mock/glm1" },
			"task.perCallModelAllow": ["mock/glm[1m]"],
		});
		const grants = { settings, agentName: "worker" };
		expect(approved(bracketed, grants)).toBe(true);
		expect(approved(bracketImposter, grants)).toBe(false);
	});

	it("retains upstream pins when an allowlist expands a configured role", () => {
		const settings = Settings.isolated({
			modelRoles: {
				review: "openrouter/anthropic/claude-sonnet-4.5@anthropic:high",
				unpinned: "openrouter/anthropic/claude-sonnet-4.5",
			},
			"task.perCallModelAllow": ["@review"],
		});
		const grants = { settings, agentName: "worker" };
		expect(approved(pinnedSonnet, grants)).toBe(true);
		expect(approved(sonnet, grants)).toBe(false);
		expect(getPerCallModelAdvertisement(settings, undefined, registry).roles).toEqual([
			{ role: "review", patterns: ["openrouter/anthropic/claude-sonnet-4.5@anthropic:high"] },
		]);
	});

	it("invalidates approval and advertisement caches when role allowlist resolution changes", () => {
		const first = createMockModel({ id: "worker" });
		const second = createMockModel({ id: "worker:low" });
		let catalog = [first];
		const modelRegistry = { getAll: () => catalog, getAvailable: () => catalog };
		const settings = Settings.isolated({
			modelRoles: { review: "mock/worker, mock/worker:low", scope: "mock/worker:low" },
			"task.perCallModelAllow": ["@scope"],
		});
		const grants = { settings, agentName: "worker" };
		expect(approved(first, grants, modelRegistry)).toBe(true);
		expect(
			getPerCallModelAdvertisement(settings, undefined, modelRegistry).roles.find(({ role }) => role === "review")
				?.patterns,
		).toEqual(["mock/worker", "mock/worker:low"]);

		// Every value is qualified: only the allowlist's full-catalog literal check adds this dependency.
		catalog = [second];
		expect(approved(first, grants, modelRegistry)).toBe(false);
		expect(approved(second, grants, modelRegistry)).toBe(true);
		expect(
			getPerCallModelAdvertisement(settings, undefined, modelRegistry).roles.find(({ role }) => role === "review")
				?.patterns,
		).toEqual(["mock/worker:low"]);

		settings.setModelRole("scope", "mock/worker");
		expect(approved(second, grants, modelRegistry)).toBe(false);
		expect(getPerCallModelAdvertisement(settings, undefined, modelRegistry).roles).toEqual([]);
		cfgTaskPerCallModelAllow.override(settings, ["mock/w*"]);
		expect(approved(second, grants, modelRegistry)).toBe(true);
		expect(
			getPerCallModelAdvertisement(settings, undefined, modelRegistry).roles.find(({ role }) => role === "review")
				?.patterns,
		).toContain("mock/worker:low");
	});

	it("a role removed from the operator's settings stops granting even when a child snapshotted it", () => {
		const root = Settings.isolated({ modelRoles: { review: "mock/target" } });
		// Spawn-time snapshot: the child copies the root's roles into its own overrides.
		const child = root.overlay({ modelRoles: { ...root.getModelRoles(), advisor: "mock/other" } }, { derived: true });
		root.setModelRole("review", undefined);
		const grandchild = child.overlay({}, { derived: true });
		expect(approved(target, { settings: grandchild, agentName: "worker" })).toBe(false);
	});

	it("honors roles and allowlists configured by an SDK host overlay", () => {
		const settings = Settings.isolated().overlay({
			modelRoles: { review: "mock/target, mock/other" },
			"task.perCallModelAllow": ["mock/target"],
		});
		const grants = { settings, agentName: "worker" };
		expect(approved(target, grants)).toBe(true);
		expect(approved(other, grants)).toBe(false);
	});

	it("resolves grants against spawn-time preferences while role and allowlist edits remain live", () => {
		const first = createMockModel({ id: "worker-a" });
		const second = createMockModel({ id: "worker-b" });
		const usageOrder = ["mock/worker-a", "mock/worker-b"];
		const settings = Settings.isolated(
			{ modelRoles: { review: "worker" } },
			{ storage: { getModelUsageOrder: () => usageOrder } as AgentStorage },
		);
		const grants: PerCallModelGrants = {
			settings,
			agentName: "worker",
			matchPreferences: structuredClone(getModelMatchPreferences(settings)),
		};
		const catalog = [first, second];
		const modelRegistry = { getAll: () => catalog, getAvailable: () => catalog };
		expect(approved(first, grants, modelRegistry)).toBe(true);
		usageOrder.reverse();
		expect(approved(first, grants, modelRegistry)).toBe(true);
		expect(approved(second, grants, modelRegistry)).toBe(false);
		cfgTaskPerCallModelAllow.override(settings, ["mock/worker-b"]);
		expect(approved(first, grants, modelRegistry)).toBe(false);
		cfgTaskPerCallModelAllow.override(settings, []);
		settings.setModelRole("review", undefined);
		expect(approved(first, grants, modelRegistry)).toBe(false);
	});

	it.each([
		{ only: ["anthropic", "google-vertex"] },
		{ order: ["anthropic", "google-vertex"] },
		{ only: ["anthropic"], allowFallbacks: true },
	])("does not collapse a parent's routing policy into a grant: %j", routing => {
		const model = { ...sonnet, compat: { ...sonnet.compat, openRouterRouting: routing } } as Model;
		expect(parentModelGrantPattern(model)).toBeUndefined();
	});

	it("captures a faithfully representable parent upstream pin", () => {
		expect(parentModelGrantPattern(pinnedSonnet)).toBe("openrouter/anthropic/claude-sonnet-4.5@anthropic");
	});

	it("never trusts a project agent file that claims a user source", () => {
		const agent = parseAgent(
			"/project/.omp/agents/worker.md",
			["---", "name: worker", "description: Worker", "source: user", "model: mock/target", "---", "Work."].join(
				"\n",
			),
			"project",
		);
		const grants = {
			settings: Settings.isolated(),
			agentName: agent.name,
			agentModel: agent.model,
			agentSource: agent.source,
		};
		expect(approved(target, grants)).toBe(false);
	});

	it("rejects a non-string task.perCallModelAllow entry from a config file and a runtime write", async () => {
		const tempDir = TempDir.createSync("@pi-per-call-allow-");
		try {
			const overlay = tempDir.join("overlay.yml");
			await Bun.write(overlay, "task:\n  perCallModelAllow:\n    - mock/target\n    - 42\n");
			await expect(Settings.loadIsolated({ inMemory: true, configFiles: [overlay] })).rejects.toThrow(
				"Invalid task.perCallModelAllow[1]",
			);
		} finally {
			tempDir.removeSync();
		}
		expect(() => Settings.isolated({ "task.perCallModelAllow": [{ id: "mock/target" }] })).toThrow(
			"Invalid task.perCallModelAllow[0]",
		);
	});
});

// Repository settings are agent-writable, so they may narrow per-call grants but never widen them.
describe("project settings and per-call grants", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-per-call-project-");
		agentDir = tempDir.join("agent");
		project = tempDir.join("repo");
		for (const dir of [agentDir, project]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	function writeRepositorySettings(settings: Record<string, unknown>): void {
		fs.mkdirSync(getProjectAgentDir(project), { recursive: true });
		fs.writeFileSync(path.join(getProjectAgentDir(project), "settings.json"), JSON.stringify(settings));
	}

	async function load(operator: Record<string, unknown>, repository?: Record<string, unknown>): Promise<Settings> {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(operator));
		if (repository) writeRepositorySettings(repository);
		return Settings.loadIsolated({ cwd: project, agentDir });
	}

	it("never grants through a project role, including one written mid-session", async () => {
		const settings = await load({ modelRoles: { review: "mock/target" } });
		writeRepositorySettings({ modelRoles: { smol: "mock/other", review: "mock/other" } });
		// Preflight reloads settings before every spawn.
		await settings.reloadFromDisk();
		expect(settings.getModelRole("smol")).toBe("mock/other");
		const grants = { settings, agentName: "worker" };
		expect(approved(other, grants)).toBe(false);
		// The operator's own value still grants beneath a project override of the same role.
		expect(approved(target, grants)).toBe(true);
		expect(getPerCallModelAdvertisement(settings).roles).toEqual([{ role: "review", patterns: ["mock/target"] }]);
	});

	it.each<{ operator: string[]; repository: string[]; admitted: string[] }>([
		{ operator: ["mock/target"], repository: ["mock/target", "mock/other"], admitted: ["target"] },
		{ operator: [], repository: ["mock/other"], admitted: ["other"] },
	])(
		"admits $admitted with operator allowlist $operator and project allowlist $repository",
		async ({ operator, repository, admitted }) => {
			const settings = await load(
				{ modelRoles: { review: "mock/target, mock/other" }, task: { perCallModelAllow: operator } },
				{ task: { perCallModelAllow: repository } },
			);
			const grants = { settings, agentName: "worker" };
			expect([target, other].filter(model => approved(model, grants)).map(model => model.id)).toEqual(admitted);
		},
	);

	it.each([
		{ operator: "off", repository: "on", task: false, evalCall: false },
		{ operator: "on", repository: "off", task: false, evalCall: false },
		{ operator: "on", repository: "eval", task: false, evalCall: true },
		{ operator: "eval", repository: "on", task: false, evalCall: true },
	])(
		"lets project task.perCallModel $repository only narrow operator $operator",
		async ({ operator, repository, task, evalCall }) => {
			const settings = await load({ task: { perCallModel: operator } }, { task: { perCallModel: repository } });
			expect(perCallModelEnabled(settings, "task")).toBe(task);
			expect(perCallModelEnabled(settings, "eval")).toBe(evalCall);
		},
	);

	it("drops the frontmatter grant of an agent the project disables", async () => {
		const settings = await load({}, { task: { disabledAgents: ["worker"] } });
		const grants = { settings, agentName: "worker", agentSource: "user" as const, agentModel: ["mock/target"] };
		expect(approved(target, grants)).toBe(false);
	});
});
