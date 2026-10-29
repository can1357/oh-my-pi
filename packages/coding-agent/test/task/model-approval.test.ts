import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { factoryDroidRegistry } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { getModelMatchPreferences, parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import {
	assertPerCallDispatchModel,
	assertPerCallModelApproved,
	getPerCallModelAdvertisement,
	parentModelGrantPattern,
	PerCallModelError,
	type PerCallModelGrants,
} from "@oh-my-pi/pi-coding-agent/task/model-approval";
import { cfgTaskPerCallModelAllow } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";

const target = createMockModel({ id: "target" });
const other = createMockModel({ id: "other" });
const bracketed = createMockModel({ id: "glm[1m]" });
const bracketImposter = createMockModel({ id: "glm1" });
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
const droidModel = (id: string, rotation: string[]) =>
	buildModel(
		buildFactoryDroidModel(
			factoryDroidRegistry().find(entry => entry.spec.id === id)!,
			{ apiProviders: rotation },
		),
	);
// Factory sends Fable's refusal chain to Opus 5 natively on the first-party Anthropic upstream.
const droidFable = droidModel("claude-fable-5", ["anthropic"]);
const droidVertexFable = droidModel("claude-fable-5.1", ["vertex_anthropic"]);
const droidOpus = droidModel("claude-opus-5", ["anthropic"]);
const chat = [
	target,
	other,
	bracketed,
	bracketImposter,
	sonnet,
	codingRouter,
	codingRouterLow,
	droidFable,
	droidVertexFable,
	droidOpus,
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
	{ name: "role value naming another model", settings: { modelRoles: { review: "mock/other" } }, approved: false },
	{ name: "glob role value", settings: { modelRoles: { review: "mock/*" } }, approved: true },
	{ name: "bare-id glob role value", settings: { modelRoles: { review: "tar?et" } }, approved: true },
	{ name: "glob role value with a level", settings: { modelRoles: { review: "mock/*:high" } }, approved: true },
	{
		name: "a provider-scoped glob never matches a different provider's bare id",
		settings: { modelRoles: { review: "anthropic/*" } },
		model: sonnet,
		approved: false,
	},
	{
		name: "a glob keeps an explicit upstream pin",
		settings: { modelRoles: { review: "openrouter/anthropic/*@anthropic" } },
		model: pinnedSonnet,
		approved: true,
	},
	{
		name: "an unpinned provider glob does not grant a pinned route",
		settings: { modelRoles: { review: "openrouter/*" } },
		model: pinnedSonnet,
		approved: false,
	},
	{
		name: "a provider glob spans slashes in aggregator ids",
		settings: { modelRoles: { review: "openrouter/*" } },
		model: sonnet,
		approved: true,
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
		name: "allowlist admits a listed granted model",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/target"] },
		approved: true,
	},
	{
		name: "the allowlist compares a level-shaped entry literally",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/target:high"] },
		approved: false,
	},
	{
		name: "the allowlist never resolves a bare id",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["target"] },
		approved: false,
	},
	{
		name: "the allowlist expands provider-scoped globs",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/*"] },
		approved: true,
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
		name: "an allowlist bare-id glob matches only the bare id",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["tar?et"] },
		approved: true,
	},
	{
		name: "brackets in an allowlist glob are literal",
		settings: { modelRoles: { review: "mock/*" }, "task.perCallModelAllow": ["mock/glm[1m]*"] },
		model: bracketImposter,
		approved: false,
	},
	{
		name: "an allowlist bracketed glob admits the literal brackets",
		settings: { modelRoles: { review: "mock/*" }, "task.perCallModelAllow": ["mock/glm[1m]*"] },
		model: bracketed,
		approved: true,
	},
	{
		name: "an unpinned allowlist glob does not admit a pinned route",
		settings: {
			modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5@anthropic" },
			"task.perCallModelAllow": ["openrouter/*"],
		},
		model: pinnedSonnet,
		approved: false,
	},
	{
		name: "an allowlist glob keeps an explicit upstream pin",
		settings: {
			modelRoles: { review: "openrouter/anthropic/claude-sonnet-4.5@anthropic" },
			"task.perCallModelAllow": ["openrouter/*@anthropic"],
		},
		model: pinnedSonnet,
		approved: true,
	},
	{
		name: "brackets in a literal id are not a glob",
		settings: { modelRoles: { review: "mock/glm[1m]" } },
		model: bracketed,
		approved: true,
	},
	{
		name: "a literal bracketed grant approves only itself",
		settings: { modelRoles: { review: "mock/glm[1m]" } },
		approved: false,
	},
	{
		name: "an unavailable bracketed literal never becomes a glob",
		settings: { modelRoles: { review: "mock/glm[1m]" } },
		unavailable: bracketed,
		model: bracketImposter,
		approved: false,
	},
	{
		name: "brackets stay literal within an actual glob",
		settings: { modelRoles: { review: "mock/glm[1m]*" } },
		model: bracketed,
		approved: true,
	},
	{
		name: "a non-chat model never qualifies",
		settings: { modelRoles: { review: "mock/*" } },
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
		name: "an upstream-pinned parent model does not grant the unpinned model",
		parentModelPattern: "openrouter/anthropic/claude-sonnet-4.5@anthropic",
		model: sonnet,
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
		name: "a role naming a catalog id with a level-shaped suffix does not grant the base id",
		settings: { modelRoles: { review: "nanogpt/nanogpt/coding-router:low" } },
		model: codingRouter,
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
			modelRoles: { review: "nanogpt/*" },
			"task.perCallModelAllow": ["nanogpt/nanogpt/coding-router:low"],
		},
		model: codingRouterLow,
		approved: true,
	},
	{
		name: "an allowlisted catalog id with a level-shaped suffix does not admit the base id",
		settings: {
			modelRoles: { review: "nanogpt/*" },
			"task.perCallModelAllow": ["nanogpt/nanogpt/coding-router:low"],
		},
		model: codingRouter,
		approved: false,
	},
	{
		name: "an allowlist role never splits an unavailable literal's level-shaped suffix",
		settings: {
			modelRoles: { review: "nanogpt/nanogpt/coding-router:low", smol: "nanogpt/nanogpt/coding-router" },
			"task.perCallModelAllow": ["@review"],
		},
		unavailable: codingRouterLow,
		model: codingRouter,
		approved: false,
	},
	{
		name: "a model whose provider may fall back server-side is approved: the request omits the chain and a handoff fails closed",
		settings: { modelRoles: { review: "factory-droid/claude-fable-5" } },
		model: droidFable,
		approved: true,
	},
	{
		name: "a model whose server-side fallback target is also approved stays approved",
		settings: { modelRoles: { review: "factory-droid/claude-fable-5", smol: "factory-droid/claude-opus-5" } },
		model: droidFable,
		approved: true,
	},
	{
		name: "a route without a server-side fallback needs no fallback approval",
		settings: { modelRoles: { review: "factory-droid/claude-fable-5.1" } },
		model: droidVertexFable,
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
];

describe("per-call model advertisement", () => {
	it("advertises no built-in role defaults", () => {
		expect(getPerCallModelAdvertisement(Settings.isolated())).toEqual({
			roles: [],
			allowlist: [],
			parentModelWithheld: false,
		});
	});

	it("withholds the own-model clause when the parent's routing cannot be written as one selector", () => {
		const settings = Settings.isolated({ modelRoles: { smol: "mock/target" } });
		const routed = buildModel({
			id: "multi-route",
			name: "multi-route",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
			compat: { openRouterRouting: { only: ["anthropic", "google-vertex"] } },
		});
		expect(getPerCallModelAdvertisement(settings, routed).parentModelWithheld).toBe(true);
		expect(getPerCallModelAdvertisement(settings, target).parentModelWithheld).toBe(false);
		expect(getPerCallModelAdvertisement(settings).parentModelWithheld).toBe(false);
	});

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

	it("reads live grant authority, excluding derived settings but honoring host overlays", () => {
		const root = Settings.isolated({
			modelRoles: { smol: "mock/target" },
			"task.perCallModelAllow": ["mock/target"],
		});
		const child = root.overlay(
			{ modelRoles: { slow: "mock/other" }, "task.perCallModelAllow": ["mock/other"] },
			{ derived: true },
		);
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

	it("a role removed from the operator's settings stops granting even when a child snapshotted it", () => {
		const root = Settings.isolated({ modelRoles: { review: "mock/target" } });
		// Spawn-time snapshot: the child copies the root's roles into its own overrides.
		const child = root.overlay({ modelRoles: { ...root.getModelRoles(), advisor: "mock/other" } }, { derived: true });
		root.setModelRole("review", undefined);
		const grandchild = child.overlay({}, { derived: true });
		expect(approved(target, { settings: grandchild, agentName: "worker" })).toBe(false);
	});

	it("honors an SDK host overlay's allowlist", () => {
		const settings = Settings.isolated({ modelRoles: { review: "mock/target" } }).overlay({
			"task.perCallModelAllow": ["mock/other"],
		});
		expect(approved(target, { settings, agentName: "worker" })).toBe(false);
	});

	it("honors roles configured by an SDK host overlay", () => {
		const settings = Settings.isolated().overlay({ modelRoles: { review: "mock/target" } });
		expect(approved(target, { settings, agentName: "worker" })).toBe(true);
	});

	it("resolves grants against spawn-time preferences while role and allowlist edits remain live", () => {
		const first = createMockModel({ id: "worker-a" });
		const second = createMockModel({ id: "worker-b" });
		const usageOrder = ["mock/worker-a", "mock/worker-b"];
		const settings = Settings.isolated(
			{ modelRoles: { review: "worker" }, "task.perCallModelAllow": ["@review"] },
			{ storage: { getModelUsageOrder: () => usageOrder } as AgentStorage },
		);
		const grants: PerCallModelGrants = {
			settings,
			agentName: "worker",
			matchPreferences: structuredClone(getModelMatchPreferences(settings)),
		};
		const modelRegistry = { getAll: () => [first, second], getAvailable: () => [first, second] };
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

	it("approves a Factory model whose transport carries a refusal chain when its target is also granted", () => {
		const grants = {
			settings: Settings.isolated({
				modelRoles: { review: "factory-droid/claude-fable-5", smol: "factory-droid/claude-opus-5" },
			}),
			agentName: "worker",
		};
		expect(() => assertPerCallModelApproved(droidFable, grants, registry)).not.toThrow();
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

	it("names the allowlist in the rejection when one is set", () => {
		const grants = { settings: Settings.isolated({ "task.perCallModelAllow": ["mock/other"] }), agentName: "worker" };
		expect(() => assertPerCallModelApproved(target, grants, registry)).toThrow(/task\.perCallModelAllow/);
	});

	it.each([
		["a provider glob", ["openai/*"], true],
		["a literal level-shaped glob", ["openai/*:high"], false],
		["a role whose value is a provider glob", ["@scope"], true],
	])("keeps %s in the allowlist on that provider", (_name, allow, directApproved) => {
		const direct = createMockModel({ provider: "openai", id: "gpt-5" });
		const routed = createMockModel({ provider: "openrouter", id: "openai/gpt-5" });
		const providers = { getAll: () => [direct, routed], getAvailable: () => [direct, routed] };
		const settings = Settings.isolated({
			modelRoles: { review: "openrouter/openai/gpt-5", fast: "openai/gpt-5", scope: "openai/*" },
			"task.perCallModelAllow": allow,
		});
		const grants = { settings, agentName: "worker" };
		// Granted by `review`, but its bare id `openai/gpt-5` must not satisfy an `openai/*` entry.
		expect(approved(routed, grants, providers)).toBe(false);
		expect(approved(direct, grants, providers)).toBe(directApproved);
	});
});

describe("per-call dispatch with runtime fallbacks", () => {
	const chained = { modelRoles: { review: "mock/other" }, "retry.fallbackChains": { review: ["mock/target:high"] } };
	const dispatch =
		(settings: Record<string, unknown>, model: Model = target) =>
		() =>
			assertPerCallDispatchModel(model, { settings: Settings.isolated(settings), agentName: "worker" }, registry);

	it.each([
		["off: a chain entry is refused", chained, /perCallModelFallbacks: runtime/],
		[
			"runtime: a wildcard chain entry never grants",
			{ ...chained, "retry.fallbackChains": { "mock/*": ["mock/*"] }, "task.perCallModelFallbacks": "runtime" },
			/not approved/,
		],
		[
			"runtime: a question-mark wildcard chain entry never grants",
			{ ...chained, "retry.fallbackChains": { review: ["mock/tar?et"] }, "task.perCallModelFallbacks": "runtime" },
			/not approved/,
		],
		[
			"runtime: a level-shaped exact allowlist entry stays literal",
			{ ...chained, "task.perCallModelFallbacks": "runtime", "task.perCallModelAllow": ["mock/target:high"] },
			/task\.perCallModelAllow/,
		],
		[
			"runtime: a chain entry outside the allowlist is refused",
			{ ...chained, "task.perCallModelFallbacks": "runtime", "task.perCallModelAllow": ["mock/other"] },
			/task\.perCallModelAllow/,
		],
	] as const)("%s", (_name, settings, error) => {
		expect(dispatch(settings)).toThrow(error);
	});

	it("runtime: a concrete chain entry may be sent to but never requested", () => {
		const settings = { ...chained, "task.perCallModelFallbacks": "runtime" };
		expect(dispatch(settings)).not.toThrow();
		expect(approved(target, { settings: Settings.isolated(settings), agentName: "worker" }, registry)).toBe(false);
		// A non-chat model named in a chain stays out of reach.
		const imageChain = { ...settings, "retry.fallbackChains": { review: ["mock/painter"] } };
		expect(dispatch(imageChain, image)).toThrow(/not approved/);
	});

	it("runtime: reads the opt-in and chain from the operator's settings, never a subagent overlay", () => {
		const grants = (settings: Settings) => ({ settings, agentName: "worker" });
		// The executor installs the worker's own `subagent:<id>` chain on its overlay; that never grants.
		const overlaid = Settings.isolated({ ...chained, "retry.fallbackChains": {} }).overlay(
			{
				"task.perCallModelFallbacks": "runtime",
				"retry.fallbackChains": { "subagent:x": ["mock/target"] },
			},
			{ derived: true },
		);
		expect(() => assertPerCallDispatchModel(target, grants(overlaid), registry)).toThrow(/not approved/);
		const operator = Settings.isolated({ ...chained, "task.perCallModelFallbacks": "runtime" }).overlay(
			{ "task.perCallModelFallbacks": "off" },
			{ derived: true },
		);
		expect(() => assertPerCallDispatchModel(target, grants(operator), registry)).not.toThrow();
	});

	it("runtime: honors a host overlay as its own grant authority", () => {
		const host = Settings.isolated({ ...chained, "task.perCallModelFallbacks": "runtime" }).overlay({
			"task.perCallModelFallbacks": "off",
		});
		expect(() => assertPerCallDispatchModel(target, { settings: host, agentName: "worker" }, registry)).toThrow(
			/perCallModelFallbacks: runtime/,
		);
		const enabledHost = Settings.isolated({ ...chained }).overlay({ "task.perCallModelFallbacks": "runtime" });
		expect(() =>
			assertPerCallDispatchModel(target, { settings: enabledHost, agentName: "worker" }, registry),
		).not.toThrow();
	});

	it("runtime: unavailable chain literals never broaden to their level-shaped siblings", () => {
		const modelRegistry = { ...registry, getAvailable: () => chat.filter(model => model !== codingRouterLow) };
		const grants = {
			settings: Settings.isolated({
				modelRoles: { review: "mock/other" },
				"retry.fallbackChains": { review: ["nanogpt/nanogpt/coding-router:low"] },
				"task.perCallModelFallbacks": "runtime",
			}),
			agentName: "worker",
		};
		expect(() => assertPerCallDispatchModel(codingRouter, grants, modelRegistry)).toThrow(/not approved/);
	});

	it("runtime: uses the same scoped role and glob allowlist rules as initial approval", () => {
		const settings = {
			modelRoles: { review: "mock/other", scope: "anthropic/*" },
			"retry.fallbackChains": { review: ["openrouter/anthropic/claude-sonnet-4.5"] },
			"task.perCallModelFallbacks": "runtime",
		};
		expect(dispatch({ ...settings, "task.perCallModelAllow": ["anthropic/*"] }, sonnet)).toThrow(/not approved/);
		expect(dispatch({ ...settings, "task.perCallModelAllow": ["@scope"] }, sonnet)).toThrow(/not approved/);
		expect(dispatch({ ...settings, "task.perCallModelAllow": ["openrouter/*"] }, sonnet)).not.toThrow();
	});

	it("runtime: freezes non-exact chain matching at spawn while allowlist edits stay live", () => {
		const first = createMockModel({ id: "worker-a" });
		const second = createMockModel({ id: "worker-b" });
		const usageOrder = ["mock/worker-a", "mock/worker-b"];
		const settings = Settings.isolated(
			{
				modelRoles: { review: "mock/other" },
				"retry.fallbackChains": { review: ["worker"] },
				"task.perCallModelFallbacks": "runtime",
				"task.perCallModelAllow": ["mock/*"],
			},
			{ storage: { getModelUsageOrder: () => usageOrder } as AgentStorage },
		);
		const grants = {
			settings,
			agentName: "worker",
			matchPreferences: structuredClone(getModelMatchPreferences(settings)),
		};
		const modelRegistry = { getAll: () => [first, second], getAvailable: () => [first, second] };
		usageOrder.reverse();
		expect(() => assertPerCallDispatchModel(first, grants, modelRegistry)).not.toThrow();
		expect(() => assertPerCallDispatchModel(second, grants, modelRegistry)).toThrow(/not approved/);
		cfgTaskPerCallModelAllow.override(settings, ["mock/worker-b"]);
		expect(() => assertPerCallDispatchModel(first, grants, modelRegistry)).toThrow(/not approved/);
	});

	it("runtime: a chain entry's @upstream pin is part of its identity", () => {
		const pinnedChain = {
			modelRoles: { review: "mock/other" },
			"retry.fallbackChains": { review: ["openrouter/anthropic/claude-sonnet-4.5@anthropic"] },
			"task.perCallModelFallbacks": "runtime",
		};
		expect(dispatch(pinnedChain, pinnedSonnet)).not.toThrow();
		expect(dispatch(pinnedChain, sonnet)).toThrow(/not approved/);
	});

	it("runtime: a Factory Droid server-side fallback chain entry is dispatched, since the request omits the chain", () => {
		const droidChain = {
			modelRoles: { review: "mock/other" },
			"retry.fallbackChains": { review: ["factory-droid/claude-fable-5"] },
			"task.perCallModelFallbacks": "runtime",
		};
		expect(dispatch(droidChain, droidFable)).not.toThrow();
		const withTarget = {
			...droidChain,
			"retry.fallbackChains": { review: ["factory-droid/claude-fable-5", "factory-droid/claude-opus-5"] },
		};
		expect(dispatch(withTarget, droidFable)).not.toThrow();
	});
});
