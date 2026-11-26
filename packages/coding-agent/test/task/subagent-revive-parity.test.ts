/**
 * A subagent revived from its stored session (cold) is built as one revived in memory (warm): each route spawns a
 * real subagent, parks it, revives it warm and wakes it, parks it again, drops the warm reviver as a worker's exit
 * does, and revives it cold and wakes it. Every option of the two revives' `createAgentSession` calls is compared,
 * and so are the first requests after each revive.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	fixtureAgent,
	type LiveParent,
	openReviveEnv,
	type ParityRun,
	type ReviveEnv,
	type RevivedSubagent,
} from "./revive-harness";

/**
 * The accepted differences between a warm and a cold revive. Only the first is an option of a build that these
 * routes compare as different; the others name state the builds do not compare, or values that differ only where
 * live state changed since the spawn, which no route here changes.
 */
const ACCEPTED_DIFFERENCES = [
	"1. The dispatch guard (assertDispatchModel), which holds a per-call worker to its grants and an offline subagent to the active parent provider: the warm revive keeps the spawn's; the cold revive builds one against the grants and the provider as they are at the revive.",
	"2. Settings that the subagent wrote to its overlay during its run: the warm revive keeps them; the cold revive restores the overlay the spawn wrote.",
	"3. A family cache candidate that the parent stashed at spawn and that no request promoted yet: the warm revive holds it in memory; the cold revive does not have it.",
	"4. On a later build, the IRC roster: the warm revive can keep the roster that the live prompt showed; the cold revive collects it again.",
	"5. A live input of a parent that is not live: the cold revive takes the root's.",
	"6. A custom tool that the cold revive cannot build again: both revives keep it in the tool list; on the cold revive a call to it answers that it is unavailable.",
	"7. Values the cold revive holds to the live process where they changed since the spawn: the cwd (the live root's, so after the root moves the cold revive builds in its new directory and the warm revive in the spawn's), the wake limits (the tighter of stored and live), the task depth (never shallower than the live parent chain), the credential source and workspace roots (the live parent's), the LSP, IRC and MCP policy (narrowed to the root's), disabled providers, and a stored model that cannot start the revive (the live parent's model).",
	"8. The extension roots of a spawner that passed none (a vibe worker): the warm revive passes none; the cold revive passes the live parent's with an empty explicit list.",
] as const;

/**
 * How one option of the two revives' builds is compared: `data`, plain data with every live object and function
 * replaced by an identity tag (same object or not); `flag`, a flag the session reads as false when absent; `model`,
 * the model by its exact identity; `prewalk`, the target by its identity and its level; `settings`, the overlay's
 * own layers when the build was made and the parent settings by identity; `session`, the reopened session by its
 * file; `ref`, the claimed registry ref by its id; `tools`, tools by name, label, description, parameters and load
 * mode; `roots`, a provider function by what it returns; `prompt`, the system prompt builder by its output on one
 * default prompt right after the revive; `accepted`, an accepted difference, named and not compared.
 */
type Compare =
	| "data"
	| "flag"
	| "model"
	| "prewalk"
	| "settings"
	| "session"
	| "ref"
	| "tools"
	| "roots"
	| "prompt"
	| "accepted";

/** Every option of a subagent build. The type check fails when `createAgentSession` gains an option this table leaves out. */
const OPTION_COMPARES = {
	// Stored in the spawn spec.
	cwd: "data",
	additionalDirectories: "data",
	credentialSourceSessionId: "data",
	model: "model",
	thinkingLevel: "data",
	thinkingLevelCeiling: "data",
	cacheWarming: "data",
	toolNames: "data",
	outputSchema: "data",
	outputSchemaMode: "data",
	restrictToolNames: "flag",
	requireYieldTool: "flag",
	noContextFiles: "flag",
	prewalk: "prewalk",
	spawns: "data",
	taskDepth: "data",
	parentTaskPrefix: "data",
	parentAgentId: "data",
	agentId: "data",
	agentDisplayName: "data",
	agentName: "data",
	enableLsp: "data",
	enableIrc: "data",
	skipPythonPreflight: "flag",
	enableMCP: "data",
	mountedToolNames: "data",
	// Replaced at a revive by the stored model.
	modelPattern: "data",
	modelPatternParentFallback: "data",
	modelPatternFallbackRole: "data",
	modelPatternDefaultFallbackChain: "data",
	// Derived from the stored per-call flag, and from offline mode.
	disableModelFallback: "flag",
	disableServerSideFallback: "flag",
	// Set by no subagent build, so the SDK default holds on every path.
	additionalExtensionPaths: "data",
	advertiseHeadlessAsk: "data",
	agentDir: "data",
	agentRegistry: "data",
	allowRestrictedCustomTools: "data",
	allowSessionModelFallback: "data",
	appendSystemPrompt: "data",
	autoApprove: "data",
	autoTitle: "data",
	bindProcessState: "data",
	customSystemPrompt: "data",
	deadline: "data",
	deferRetryFallbackValidation: "data",
	deferHintCompression: "data",
	deferUsageReserveConfirmation: "data",
	deferredExtensionPaths: "data",
	deferredPrewalk: "data",
	eventBus: "data",
	extensions: "data",
	topLevelExtensions: "data",
	disableExtensionDiscovery: "data",
	interactivePrompts: "data",
	jobCaptionWriter: "data",
	jobWidgetAuthor: "data",
	lspReadOnly: "data",
	modelRole: "data",
	onPrewalkWarning: "data",
	openAIServiceTier: "data",
	planYolo: "data",
	preloadedExtensions: "data",
	providerPromptCacheKey: "data",
	providerPromptCacheKeySource: "data",
	providerSessionId: "data",
	rebindModelAfterDiscovery: "data",
	scopedModels: "data",
	scopedModelsFromSettings: "data",
	settingsApproval: "data",
	settingsManager: "data",
	slashCommands: "data",
	suppressAutoPrewalk: "data",
	systemPromptTemplate: "data",
	tanFork: "data",
	taskPromptCacheKey: "data",
	titleSystemPrompt: "data",
	tuiTranscript: "data",
	// Constants of every spawn.
	excludeAgentsMd: "flag",
	hasUI: "flag",
	// Live inputs of the process: the spawner's at the spawn and a warm revive, the live parent's at a cold revive.
	costGate: "data",
	authStorage: "data",
	modelRegistry: "data",
	getApiKey: "data",
	oauthAccountPools: "data",
	inheritedSessionAgents: "data",
	assertDispatchModel: "accepted",
	contextFiles: "data",
	skills: "data",
	promptTemplates: "data",
	workspaceTree: "data",
	rules: "data",
	extensionRoots: "roots",
	preloadedExtensionPaths: "data",
	preloadedPreparedExtensions: "data",
	preloadedCustomToolPaths: "data",
	subagentEventBus: "data",
	parentHindsightSessionState: "data",
	parentMnemopiSessionState: "data",
	asyncJobManager: "data",
	mcpManager: "data",
	localProtocolOptions: "data",
	telemetry: "data",
	mcpTools: "tools",
	mcpToolScope: "data",
	sessionManager: "session",
	expectedAgentRef: "ref",
	// Stored descriptors, built over the live parent's eval kernel.
	customTools: "tools",
	// Stored layers over the live parent settings.
	settings: "settings",
	// Stored prompt inputs, the held base prompt and the live default blocks.
	systemPrompt: "prompt",
	// Passed by the spawn's first build only.
	resolveServiceTierByFamily: "data",
	onFirstChatDispatch: "data",
	parentSessionKey: "data",
	awaitingAssignment: "flag",
} satisfies Record<keyof CreateAgentSessionOptions, Compare>;

type OptionName = keyof typeof OPTION_COMPARES;

const OPTION_NAMES = Object.keys(OPTION_COMPARES) as OptionName[];
const DISCOVERY_OPTIONS = ["contextFiles", "skills", "rules", "promptTemplates", "workspaceTree"] as const;

type Tags = Map<object, string>;

function tag(value: object, tags: Tags): string {
	let name = tags.get(value);
	if (!name) {
		name = `live object ${tags.size + 1}`;
		tags.set(value, name);
	}
	return name;
}

function isPlainData(value: object): boolean {
	if (Array.isArray(value)) return true;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** `value` with every live object and function replaced by an identity tag that both revives share. */
function normalized(value: unknown, tags: Tags, seen = new Set<object>()): unknown {
	if (typeof value === "function") return tag(value, tags);
	if (typeof value !== "object" || value === null) return value;
	if (!isPlainData(value) || seen.has(value)) return tag(value, tags);
	seen.add(value);
	if (Array.isArray(value)) return value.map(item => normalized(item, tags, seen));
	const members = Object.entries(value).filter(([, member]) => member !== undefined);
	return Object.fromEntries(members.map(([key, member]) => [key, normalized(member, tags, seen)]));
}

function toolShapes(tools: unknown, tags: Tags): unknown {
	if (!Array.isArray(tools)) return normalized(tools, tags);
	const shapes = tools.map(tool => {
		if (!isRecord(tool)) return tool;
		const { name, label, description, parameters, loadMode } = tool;
		return { name, label, description, parameters, loadMode };
	});
	return normalized(shapes, tags);
}

function optionValue(revived: RevivedSubagent, option: OptionName, compare: Compare, tags: Tags): unknown {
	const options = revived.build.options;
	switch (compare) {
		case "data":
			return normalized(options[option], tags);
		case "flag":
			return options[option] ?? false;
		case "model":
			return options.model ? formatModelStringWithRouting(options.model) : undefined;
		case "prewalk": {
			const prewalk = options.prewalk;
			if (!prewalk) return undefined;
			return { target: formatModelStringWithRouting(prewalk.target), thinkingLevel: prewalk.thinkingLevel };
		}
		case "settings":
			return {
				layers: normalized(revived.build.settingsLayers, tags),
				parent: normalized(options.settings?.overlayParent(), tags),
			};
		case "session":
			return options.sessionManager?.getSessionFile();
		case "ref":
			return options.expectedAgentRef === null ? null : options.expectedAgentRef?.id;
		case "tools":
			return toolShapes(options[option], tags);
		case "roots":
			return normalized(options.extensionRoots?.(), tags);
		case "prompt":
			return normalized(revived.prompt, tags);
		case "accepted":
			return undefined;
	}
}

/** One option of the warm and the cold revive's builds, each normalized with the same identity tags. */
function compareOption(run: ParityRun, option: OptionName): { warm: unknown; cold: unknown } {
	const tags: Tags = new Map();
	const compare: Compare = OPTION_COMPARES[option];
	return { warm: optionValue(run.warm, option, compare, tags), cold: optionValue(run.cold, option, compare, tags) };
}

interface ParityRoute {
	readonly title: string;
	readonly settings?: Readonly<Record<string, unknown>>;
	/** The `data` of the spawn's `yield`, where its result must fit an output schema. */
	readonly yieldData?: unknown;
	options(env: ReviveEnv, root: LiveParent): ExecutorOptions;
}

const ROUTES: ParityRoute[] = [
	{
		title: "a task subagent with an effort hint, a runtime limit, a spawn allowlist and IRC off",
		settings: { "task.maxRuntimeMs": 120_000 },
		options: (env, root) =>
			env.taskSpawn(root, "EffortHint", {
				agent: fixtureAgent({ spawns: ["explore"] }),
				effort: "lo",
				maxRuntimeMs: 120_000,
				enableIrc: false,
				parentToolCallId: "call-effort-hint",
				context: "Shared background of the batch.",
			}),
	},
	{
		title: "a task subagent with an output schema",
		yieldData: { verdict: "done" },
		options: (env, root) =>
			env.taskSpawn(root, "OutputSchema", {
				outputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
				outputSchemaMode: "permissive",
				outputSchemaSource: "caller",
				outputSchemaOverridesAgent: true,
				parentToolCallId: "call-output-schema",
			}),
	},
	{
		title: "a plan-mode subagent with a restricted contract",
		options: (env, root) =>
			env.taskSpawn(root, "PlanMode", {
				agent: fixtureAgent({ tools: ["read", "grep", "yield"] }),
				restrictToolNames: true,
				parentToolCallId: "call-plan-mode",
			}),
	},
];

for (const route of ROUTES) {
	describe(`warm and cold revives of ${route.title}`, () => {
		let env: ReviveEnv | undefined;
		let run: ParityRun | undefined;
		const ran = (): ParityRun => {
			if (!run) throw new Error(`The route "${route.title}" did not run`);
			return run;
		};

		beforeAll(async () => {
			env = await openReviveEnv(route.settings);
			if (route.yieldData !== undefined) env.yieldData = route.yieldData;
			const root = env.createLiveParent();
			run = await env.runParity(root, route.options(env, root));
		}, 60_000);

		afterAll(async () => {
			await env?.close();
		}, 30_000);

		it("the cold revive is built with the warm revive's options, but for the accepted differences", () => {
			const differing = OPTION_NAMES.flatMap(option => {
				if (OPTION_COMPARES[option] === "accepted") return [];
				const { warm, cold } = compareOption(ran(), option);
				return Bun.deepEquals(cold, warm) ? [] : [{ option, warm, cold }];
			});
			if (differing.length > 0) {
				console.log(["Accepted differences between a warm and a cold revive:", ...ACCEPTED_DIFFERENCES].join("\n"));
			}
			expect(differing).toEqual([]);
		}, 30_000);

		it("both revives start at the spawn's model and thinking level", () => {
			const { warm, cold } = ran();
			for (const revived of [warm, cold]) {
				expect(
					revived.build.options.model ? formatModelStringWithRouting(revived.build.options.model) : undefined,
				).toBe("mock/mock-model");
				expect(revived.build.options.thinkingLevel).toBe(Effort.Low);
			}
		}, 30_000);

		it("the first request after each revive carries the held base prompt and the last tool list before the park", () => {
			const { spawned, warmRequest, warmLastRequest, coldRequest } = ran();
			expect(warmRequest.system).toEqual(spawned.lastRequest.system);
			expect(warmRequest.tools).toBe(spawned.lastRequest.tools);
			expect(coldRequest.system).toEqual(warmLastRequest.system);
			expect(coldRequest.tools).toBe(warmLastRequest.tools);
		}, 30_000);

		it("with the parent live, both revives receive equal context files, skills, rules, prompt templates and workspace tree", () => {
			for (const option of DISCOVERY_OPTIONS) {
				const { warm, cold } = compareOption(ran(), option);
				const empty = warm === undefined || (Array.isArray(warm) && warm.length === 0);
				expect([option, empty]).toEqual([option, false]);
				expect([option, cold]).toEqual([option, warm]);
			}
		}, 30_000);

		it("with no live state changed since the spawn, both revives' wake turns have the same limits", () => {
			const limits = (revived: RevivedSubagent) => {
				if (!revived.wake) throw new Error("The revive attached no wake-turn monitor");
				return { maxRuntimeMs: revived.wake.maxRuntimeMs, softRequestBudget: revived.wake.softRequestBudget };
			};
			expect(limits(ran().cold)).toEqual(limits(ran().warm));
		}, 30_000);
	});
}
