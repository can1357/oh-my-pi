/**
 * What a revive from the stored session takes from its live parent session: the parent's live inputs and policy
 * fields, read on this thread or served by the parent's home thread, the custom tools its kernels define now, and
 * the live inputs the build gets from them (the root's where the parent is not live).
 */
import type { AgentIdentity } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { EvalToolDescriptor } from "../eval/types";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { MCPManager } from "../mcp/manager";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { type AgentSessionHandle, isLocalAgentSession } from "../session/agent-session-handle";
import { RemoteAgentSession } from "../thread/remote-agent-session";
import { isRpcProxy } from "../thread/rpc";
import { type SessionSettingsSource, sessionSettingsSource, settingsFromSource } from "../thread/session-mirror";
import { toWorkerCustomTool } from "../thread/services/integrations";
import type { ToolSession } from "../tools";
import type { EventBus } from "../utils/event-bus";
import { definedEvalCustomTools, unavailableEvalCustomTool } from "./eval-tools";
import {
	type SubagentLiveInputs,
	type SubagentLivePolicy,
	type SubagentSpawnerLiveInputs,
	spawnerLiveInputs,
} from "./executor";
import type { PersistedReviveSpec, PersistedSubagentReviveContext } from "./persisted-revive";
import { SPAWN_LIVE_INPUT_NAMES, type SpawnLiveInputName, type SpawnSpecPolicy } from "./spawn-spec";
import { subagentLiveInputs, subagentSpawnerPolicy } from "./structured-subagent";

/** Live parent inputs that may cross to a cold revival. */
export interface ParentLiveInputs extends SubagentSpawnerLiveInputs {
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

/** Policy values a child takes from its live spawner. */
export type ParentPolicy = Pick<SpawnSpecPolicy, "credentialSourceSessionId" | "additionalDirectories">;

/** The live inputs a parent tool session supplies to a revived child. */
export function parentLiveInputs(tools: ToolSession): ParentLiveInputs {
	return { ...subagentLiveInputs(tools), eventBus: tools.eventBus, subagentEventBus: tools.subagentEventBus };
}

/** The policy a parent tool session supplies to a revived child. */
export function parentPolicy(tools: ToolSession): ParentPolicy {
	const { credentialSourceSessionId, additionalDirectories } = subagentSpawnerPolicy(tools);
	return { credentialSourceSessionId, additionalDirectories: additionalDirectories && [...additionalDirectories] };
}

/** The live inputs a cold revive takes from the live parent session; the reviving thread adds its own. */
export type ColdReviveLiveInputs = Omit<
	SubagentLiveInputs,
	"assertDispatchModel" | "customTools" | "oauthAccountPools"
>;

/**
 * What a live parent homed on another thread sends for a cold revive of its child
 * (`SessionHostProtocol.subagentParentInputs`, answered by {@link serveSubagentParentInputs}).
 */
export interface SubagentParentInputs {
	/**
	 * Its live inputs in the forms that reach the main thread: plain data, codec values, functions, and the
	 * main-thread objects its home imported, which arrive as themselves. An object local to its home is left
	 * out, and so is the extension-roots provider, which a build calls synchronously: main reads the parent's
	 * mirrored roots instead.
	 */
	readonly live: Omit<ParentLiveInputs, "settings" | "extensionRoots">;
	/** Its settings, as the recipe main rebuilds them from. */
	readonly settings: SessionSettingsSource;
	/** Its values of the policy fields a spawn takes from its spawner. */
	readonly policy: ParentPolicy;
	/** The tools of the requested descriptors its kernels define now, as cross-thread views. */
	readonly customTools: CustomTool[];
}

/**
 * A live parent's inputs for a child's build, its policy fields, and the tools
 * of the child's descriptors its kernels define now.
 */
export interface LiveParent {
	readonly inputs: ParentLiveInputs;
	readonly policy: ParentPolicy;
	readonly customTools: readonly CustomTool[];
}

/**
 * The parent's live session: the root session for its direct children, else the parent ref's session while
 * that ref holds one; undefined when the parent ref is parked, killed or gone.
 */
export function liveParentSession(
	target: Pick<PersistedReviveSpec, "parentId" | "rootAgentId" | "root">,
): AgentSessionHandle | undefined {
	if (target.parentId === target.rootAgentId) return target.root;
	return AgentRegistry.global().get(target.parentId ?? "")?.session ?? undefined;
}

/**
 * What `session`, the live parent of subagent `id`, gives its cold revive: read from its tool session where it
 * is homed on this thread, and from its home where it is the mirror of a worker-homed session. Undefined where
 * it holds no tool session or its home cannot answer; the revive then takes the root's inputs.
 */
export async function liveParent(
	id: string,
	session: AgentSessionHandle | undefined,
	descriptors: readonly EvalToolDescriptor[],
): Promise<LiveParent | undefined> {
	if (session instanceof RemoteAgentSession) {
		let served: SubagentParentInputs | null;
		let settings: Settings;
		try {
			served = await session.subagentParentInputs(id, descriptors);
			if (!served) return undefined;
			// Served layers that fail the check, as stored ones are checked, are an answer the revive cannot take.
			settings = settingsFromSource(served.settings);
		} catch (error) {
			logger.warn("Revived subagent could not read its live parent's inputs; it takes the root's", {
				subagent: id,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		// Owner policy, read from the parent's mirror while it lives; held weakly, as a spawn holds the provider.
		const parent = new WeakRef(session);
		const roots = session.effectiveExtensionRoots;
		return {
			inputs: {
				...served.live,
				settings,
				extensionRoots: () => parent.deref()?.effectiveExtensionRoots ?? roots,
			},
			policy: served.policy,
			customTools: served.customTools,
		};
	}
	const tools = session && isLocalAgentSession(session) ? session.evalToolSession : undefined;
	if (!tools) return undefined;
	return {
		inputs: parentLiveInputs(tools),
		policy: parentPolicy(tools),
		customTools: await parentEvalCustomTools(id, tools, descriptors),
	};
}

/**
 * The home thread's answer to `SessionHostProtocol.subagentParentInputs`: what a cold revive of subagent `id`
 * takes from `session`, its live parent homed on this thread; null where the session holds no tool session.
 */
export async function serveSubagentParentInputs(
	session: AgentSession,
	id: string,
	descriptors: readonly EvalToolDescriptor[],
): Promise<SubagentParentInputs | null> {
	const tools = session.evalToolSession;
	if (!tools) return null;
	const { settings: _settings, extensionRoots: _extensionRoots, ...inputs } = parentLiveInputs(tools);
	const customTools = await parentEvalCustomTools(id, tools, descriptors);
	return {
		live: {
			...inputs,
			costGate: mainObject(inputs.costGate),
			authStorage: mainObject(inputs.authStorage),
			modelRegistry: mainObject(inputs.modelRegistry),
			asyncJobManager: mainObject(inputs.asyncJobManager),
			mcpManager: mainObject(inputs.mcpManager),
			parentArtifactManager: mainObject(inputs.parentArtifactManager),
			parentHindsightSessionState: mainObject(inputs.parentHindsightSessionState),
			parentMnemopiSessionState: mainObject(inputs.parentMnemopiSessionState),
			eventBus: mainObject(inputs.eventBus),
			subagentEventBus: mainObject(inputs.subagentEventBus),
		},
		settings: sessionSettingsSource(tools.settings),
		policy: parentPolicy(tools),
		customTools: customTools.map(tool => toWorkerCustomTool(tool)),
	};
}

/** `value` where it is a main-thread object this thread imported, which reaches main as itself; else undefined. */
function mainObject<T>(value: T | undefined): T | undefined {
	return isRpcProxy(value) ? value : undefined;
}

/**
 * The tools of `descriptors` the kernels of `tools`, a live parent's tool session, define now; none, with a
 * warning, where they cannot be read.
 */
async function parentEvalCustomTools(
	id: string,
	tools: ToolSession,
	descriptors: readonly EvalToolDescriptor[],
): Promise<CustomTool[]> {
	try {
		return await definedEvalCustomTools(tools, descriptors);
	} catch (error) {
		logger.warn("Revived subagent could not read its parent's eval tools", {
			subagent: id,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

/**
 * Live inputs a cold revive passes whatever its record's list names, since leaving one out lets the subagent do
 * more than the live process allows. Without the tree's cost gate it starts its own, which `session.maxCost` does
 * not reach; without the prepared extensions it loses a host's inline policy hooks and, as a restricted child, the
 * hooks it inherits. Every spawner passes both. The extension roots follow their own rule
 * ({@link coldReviveLiveInputs}).
 */
const KEPT_LIVE_INPUTS: Partial<Record<SpawnLiveInputName, true>> = {
	costGate: true,
	preloadedPreparedExtensions: true,
};

/**
 * The live inputs of a cold revive: the live parent's where available, else the root's.
 */
export async function coldReviveLiveInputs(
	ctx: PersistedSubagentReviveContext,
	parent: LiveParent | undefined,
	agent: AgentIdentity,
	names: readonly SpawnLiveInputName[] | undefined,
): Promise<ColdReviveLiveInputs> {
	const root = ctx.session;
	// What the process allows: the root's policy, whichever session the other inputs come from.
	const rootTools = root.evalToolSession;
	const policy: SubagentLivePolicy = {
		enableLsp: ctx.enableLsp,
		enableIrc: rootTools?.enableIrc,
		enableMCP: rootTools?.enableMCP,
	};
	const inputs = parent?.inputs ?? (rootTools ? parentLiveInputs(rootTools) : undefined);
	let live: ColdReviveLiveInputs;
	if (inputs) {
		live = {
			...spawnerLiveInputs(inputs, agent),
			preloadedCustomToolPaths: inputs.preloadedCustomToolPaths,
			authStorage: inputs.authStorage ?? ctx.authStorage,
			modelRegistry: inputs.modelRegistry ?? ctx.modelRegistry,
			subagentEventBus: inputs.subagentEventBus ?? ctx.subagentEventBus,
			mcpManager: inputs.mcpManager ?? MCPManager.instance(),
			settingsParent: inputs.settings ?? ctx.settings,
			eventBus: inputs.eventBus ?? ctx.eventBus,
			parentArtifactManager: inputs.parentArtifactManager,
			policy,
		};
	} else {
		live = {
			costGate: root.costGate,
			authStorage: ctx.authStorage,
			modelRegistry: ctx.modelRegistry,
			asyncJobManager: root.asyncJobManager,
			// Owner policy, read when the session asks, never extension authority from a transcript.
			extensionRoots: () => root.effectiveExtensionRoots,
			preloadedPreparedExtensions: root.preparedExtensions,
			mcpManager: MCPManager.instance(),
			subagentEventBus: ctx.subagentEventBus,
			settingsParent: ctx.settings,
			eventBus: ctx.eventBus,
			parentArtifactManager: root.sessionManager.getArtifactManager() ?? undefined,
			policy,
		};
	}
	const sourceRoots = live.extensionRoots;
	if (names) {
		const passed = new Set<string>(names);
		for (const name of SPAWN_LIVE_INPUT_NAMES) {
			if (!passed.has(name) && KEPT_LIVE_INPUTS[name] !== true) live[name] = undefined;
		}
		// The explicit list (`--extension`, `additionalExtensionPaths`) holds in both modes, and the agents and
		// commands of its packages would give the subagent spawn targets its spawn did not have.
		if (sourceRoots && !passed.has("extensionRoots")) {
			live.extensionRoots = () => ({ ...sourceRoots(), explicit: [] });
		}
	}
	return live;
}

/**
 * The custom tools `descriptors` name: each the tool the live parent's kernel serves (one of `served`) where a
 * kernel defines it, else built from its stored descriptor as an unavailable tool, which is named in a
 * warning. No tool is dropped.
 */
export function coldReviveCustomTools(
	id: string,
	descriptors: readonly EvalToolDescriptor[],
	served: readonly CustomTool[],
): { customTools: CustomTool[]; unavailable: string[] } {
	const byName = new Map(served.map(tool => [tool.name, tool]));
	const customTools: CustomTool[] = [];
	const unavailable: string[] = [];
	for (const descriptor of descriptors) {
		const tool = byName.get(descriptor.name);
		if (tool) {
			customTools.push(tool);
			continue;
		}
		customTools.push(unavailableEvalCustomTool(descriptor));
		unavailable.push(descriptor.name);
		logger.warn("Revived subagent keeps a custom tool no live kernel defines; a call to it answers unavailable", {
			subagent: id,
			tool: descriptor.name,
		});
	}
	return { customTools, unavailable };
}
