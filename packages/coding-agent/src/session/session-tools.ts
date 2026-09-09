import { AsyncLocalStorage } from "node:async_hooks";
import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveDelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import { isRecord, logger, prompt, stringProperty, untilAborted } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import type { Settings, SkillsSettings } from "../config/settings";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type { ExtensionRunner, SourceInfo, ToolInfo } from "../extensibility/extensions";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import { loadSkills, type Skill, type SkillWarning, setActiveSkills } from "../extensibility/skills";
import { type LocalProtocolOptions, stripXdUrlPrefix, XD_URL_PREFIX } from "../internal-urls";
import { deduplicateMCPToolsByName } from "../mcp/tool-bridge";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import { MEMORY_BACKEND_TOOL_NAMES } from "../memory-backend/tool-names";
import type { MemoryBackendStartOptions } from "../memory-backend/types";
import toolRosterNoticePrompt from "../prompts/system/tool-roster-notice.md" with { type: "text" };
import xdevMountNoticePrompt from "../prompts/system/xdev-mount-notice.md" with { type: "text" };
import { isMCPToolName, normalizeToolNames } from "../tools/builtin-names";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { isFilesystemSourcePath } from "../tools/path-utils";
import { supportsExternalThinking } from "../tools/think";
import { ToolAbortError, ToolError } from "../tools/tool-errors";
import { isMountableUnderXdev, listXdevTools, type XdevState, xdevDocsFor, xdevEntries } from "../tools/xdev";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import {
	extractPermissionLocations,
	getPermissionIntent,
	PERMISSION_OPTIONS,
	PERMISSION_OPTIONS_BY_ID,
	PERMISSION_REQUIRED_TOOLS,
} from "./acp-permission-gate";
import type { ClientBridge, ClientBridgePermissionOutcome } from "./client-bridge";
import { buildToolNamespacesInfo, resolveCodeMode, type ToolNamespacesInfo } from "./code-mode";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionToolsHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Session-local extension roots (explicit + mode + configured) for post-startup reloads. */
	effectiveExtensionRoots(): EffectiveExtensionRoots;
	modelRegistry: ModelRegistry;
	extensionRunner(): ExtensionRunner | undefined;
	clientBridge(): ClientBridge | undefined;
	agentKind(): "main" | "sub";
	isDisposed(): boolean;
	isStreaming(): boolean;
	queuedMessageCount(): number;
	planModeEnabled(): boolean;
	model(): Model | undefined;
	memoryBackendSession(): MemoryBackendStartOptions["session"];
	clearInheritedProviderPromptCacheKey(): void;
	clearMemoryPromotionSnapshot(): void;
	captureMemoryPromotionSnapshot(prompt: string[]): void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	notifyCommandMetadataChanged(): void;
	localProtocolOptions(): LocalProtocolOptions;
	/** Publishes the current Codex Code Mode tool exposure snapshot for turn metadata; undefined clears it. */
	setCodeModeNamespacesInfo?(info: unknown): void;
}

interface SessionToolsOptions {
	autoApprove?: boolean;
	toolRegistry?: Map<string, AgentTool>;
	createVibeTools?: () => AgentTool[];
	/** Creates the private `think` scratchpad tool for runtime setting changes. */
	createThinkTool?: () => Promise<AgentTool | null>;
	builtInToolNames?: Iterable<string>;
	presentationPinnedToolNames?: ReadonlySet<string>;
	/** MCP tool names whose current registry entries came from the manager snapshot. */
	mcpManagerToolNames?: Iterable<string>;
	ensureWriteRegistered?: () => Promise<boolean>;
	isDeviceOnlyWrite?: () => boolean;
	setDeviceOnlyWrite?: (enabled: boolean) => void;
	setPendingFullWriteDescription?: (enabled: boolean) => void;
	/** Registers the hidden `goal` tool when goal mode is enabled at runtime. */
	ensureGoalRegistered?: () => Promise<boolean>;
	rebuildSystemPrompt?: (
		toolNames: string[],
		tools: Map<string, AgentTool>,
		options?: { directToolNames?: readonly string[] },
	) => Promise<{ systemPrompt: string[]; xdevCatalogNames?: readonly string[] }>;
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	xdev?: XdevState;
	setActiveToolNames?: (names: Iterable<string>) => void;
	baseSystemPrompt: string[];
	skills?: Skill[];
	skillWarnings?: SkillWarning[];
	skillsSettings?: SkillsSettings;
	skillsReloadable?: boolean;
}

export interface MountedMCPToolRouteSource {
	readonly name: string;
	readonly mcpServerName?: unknown;
	readonly mcpToolName?: unknown;
}

export interface MountedMCPToolRoute {
	readonly mcpServerName: string;
	readonly mcpToolName: string;
	readonly name: string;
}

export interface MCPXdevGuidanceMapping extends MountedMCPToolRoute {
	readonly label: string;
	readonly path: string;
}

export interface MCPXdevGuidanceProjection {
	readonly mappings: readonly MCPXdevGuidanceMapping[];
	readonly hasOmittedMappings: boolean;
}

const MAX_MCP_XDEV_GUIDANCE_MAPPING_DATA_LENGTH = 4000;
const MAX_MCP_XDEV_GUIDANCE_MAPPINGS = 64;

/** Yield exact mounted MCP ownership and route metadata. */
export function* collectMountedMCPToolRoutes(
	tools: Iterable<MountedMCPToolRouteSource>,
): Generator<MountedMCPToolRoute> {
	for (const tool of tools) {
		if (typeof tool.mcpServerName !== "string" || typeof tool.mcpToolName !== "string") continue;
		yield {
			mcpServerName: tool.mcpServerName,
			mcpToolName: tool.mcpToolName,
			name: tool.name,
		};
	}
}

function formatMCPXdevGuidanceLabel(label: string): string {
	return (JSON.stringify(label) ?? '""')
		.replaceAll("`", "\\u0060")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

/**
 * Project exact live MCP routes into the bounded, Markdown-safe mapping data
 * rendered by the static MCP guidance prompt.
 */
export function projectMountedMCPXdevGuidance(routes: Iterable<MountedMCPToolRoute>): MCPXdevGuidanceProjection {
	const mappings: MCPXdevGuidanceMapping[] = [];
	let remainingMappingDataLength = MAX_MCP_XDEV_GUIDANCE_MAPPING_DATA_LENGTH;
	let hasOmittedMappings = false;
	for (const route of routes) {
		const rawMappingDataLength = route.mcpToolName.length + XD_URL_PREFIX.length + route.name.length;
		if (mappings.length >= MAX_MCP_XDEV_GUIDANCE_MAPPINGS || rawMappingDataLength > remainingMappingDataLength) {
			hasOmittedMappings = true;
			continue;
		}
		const label = formatMCPXdevGuidanceLabel(route.mcpToolName);
		const path = `${XD_URL_PREFIX}${route.name}`;
		const mappingDataLength = label.length + path.length;
		if (mappingDataLength > remainingMappingDataLength) {
			hasOmittedMappings = true;
			continue;
		}
		mappings.push({ ...route, label, path });
		remainingMappingDataLength -= mappingDataLength;
	}
	return { mappings, hasOmittedMappings };
}

const TOOL_ROSTER_NOTICE_MESSAGE_TYPE = "tool-roster-notice";
const XDEV_MOUNT_NOTICE_MESSAGE_TYPE = "xdev-mount-notice";

/**
 * Structured payload persisted on each {@link XDEV_MOUNT_NOTICE_MESSAGE_TYPE}
 * custom message. Lets a resumed session reconstruct which dynamic devices the
 * model has already been told about, so reconnecting hosts do not re-announce
 * (and re-splice a redundant developer message that busts the provider
 * prompt-cache prefix).
 */
interface XdevMountNoticeDetails {
	added: string[];
	removed: string[];
}

/** Owns tool registration, presentation, prompt rebuilding, skills, and permissions. */
export class SessionTools {
	readonly #host: SessionToolsHost;
	#autoApprove: boolean;
	#toolRegistry: Map<string, AgentTool>;
	#createVibeTools: (() => AgentTool[]) | undefined;
	#createThinkTool: SessionToolsOptions["createThinkTool"];
	#installedVibeToolNames = new Set<string>();
	#builtInToolNames: Set<string>;
	#rpcHostToolNames = new Set<string>();
	#mcpManagerToolNames = new Set<string>();
	#extensionMcpTools = new Map<string, AgentTool>();
	#xdev: XdevState | undefined;
	#pendingToolRosterDelta: { added: Set<string>; removed: Set<string> } | undefined;
	#pendingXdevMountDelta: { added: Set<string>; removed: Set<string> } | undefined;
	/**
	 * Dynamic (`xd://`) devices the model has already been told are mounted.
	 * Seeded lazily from persisted history on resume (see
	 * {@link #ensureAnnouncedMountsSeeded}) and updated as notices are emitted, so
	 * a host reconnect that re-mounts the same device does not re-announce it.
	 */
	#announcedMounts = new Set<string>();
	#announcedMountsSeeded = false;
	#presentationPinnedToolNames: ReadonlySet<string> | undefined;
	#runtimeSelectedToolNames: ReadonlySet<string> | undefined;
	#baseSystemPrompt: string[];
	/**
	 * Per-turn system prompt returned by a `before_agent_start` extension hook
	 * ("replace the system prompt for this turn"). While set, base-prompt
	 * rebuilds keep this override on the agent instead of the rebuilt base, so a
	 * rebuild landing in the prompt window (compaction/promotion, memory
	 * promotion, MCP/RPC tool refresh, hindsight MM-TTL refresh) cannot silently
	 * drop it before the request. Cleared when the turn ends.
	 */
	#turnSystemPromptOverride: string[] | undefined;
	#lastAppliedToolSignature: string | undefined;
	/** Full enabled set, including tools demoted from the model-visible surface. */
	#enabledToolNames = new Set<string>();
	/** Names currently exposed through tool-session `isToolActive` predicates. */
	#toolPredicateNames: readonly string[] | undefined;
	/** Wire-name snapshot for the direct Code Mode tools last applied successfully. */
	#codeModeDirectWireSignature: string | undefined;
	/** Direct partition of the last applied Code Mode surface; undefined when inactive. */
	#codeModeDirectToolNames: readonly string[] | undefined;
	/**
	 * `xd://` device names the current base system prompt renders in its catalog
	 * (the last rebuild's {@link BuildSystemPromptResult.xdevCatalogNames}). Consulted
	 * when a pending mount notice is delivered: a device the outgoing prompt already
	 * lists is recorded as announced without a redundant notice line. Empty when the
	 * prompt carries no catalog (no mounts, or a custom prompt that omits the section).
	 */
	#basePromptXdevNames: ReadonlySet<string> = new Set();
	#toolRegistryMutationScope = new AsyncLocalStorage<boolean>();
	#toolRegistryMutationTail: Promise<void> = Promise.resolve();
	#promptModelKey: string | undefined;
	#rebuildSystemPrompt: SessionToolsOptions["rebuildSystemPrompt"];
	#getMcpServerInstructions: SessionToolsOptions["getMcpServerInstructions"];
	#setActiveToolNames: SessionToolsOptions["setActiveToolNames"];
	#ensureWriteRegistered: SessionToolsOptions["ensureWriteRegistered"];
	#isDeviceOnlyWrite: SessionToolsOptions["isDeviceOnlyWrite"];
	#setDeviceOnlyWrite: SessionToolsOptions["setDeviceOnlyWrite"];
	#setPendingFullWriteDescription: SessionToolsOptions["setPendingFullWriteDescription"];
	/**
	 * The session originated with an xd:// transport grant. Unlike the live
	 * device-only flag, this survives temporary full-write upgrades.
	 */
	readonly #deviceOnlyWriteTransportAvailable: boolean;
	#ensureGoalRegistered: SessionToolsOptions["ensureGoalRegistered"];
	#skills: Skill[];
	#skillWarnings: SkillWarning[];
	#skillsSettings: SkillsSettings | undefined;
	#skillsReloadable: boolean;
	#acpPermissionDecisions = new Map<string, "allow_always" | "reject_always">();

	constructor(host: SessionToolsHost, options: SessionToolsOptions) {
		this.#host = host;
		this.#autoApprove = options.autoApprove === true;
		this.#toolRegistry = options.toolRegistry ?? new Map();
		this.#createVibeTools = options.createVibeTools;
		this.#createThinkTool = options.createThinkTool;
		this.#builtInToolNames = new Set(options.builtInToolNames ?? []);
		this.#mcpManagerToolNames = new Set(options.mcpManagerToolNames ?? []);
		if (options.mcpManagerToolNames === undefined) {
			for (const name of this.#toolRegistry.keys()) {
				if (isMCPToolName(name)) this.#mcpManagerToolNames.add(name);
			}
		}
		for (const [name, tool] of this.#toolRegistry) {
			if (isMCPToolName(name) && !this.#mcpManagerToolNames.has(name)) {
				this.#extensionMcpTools.set(name, tool);
			}
		}
		this.#presentationPinnedToolNames = options.presentationPinnedToolNames;
		this.#ensureWriteRegistered = options.ensureWriteRegistered;
		this.#isDeviceOnlyWrite = options.isDeviceOnlyWrite;
		this.#deviceOnlyWriteTransportAvailable = this.#isDeviceOnlyWrite?.() === true;
		this.#setDeviceOnlyWrite = options.setDeviceOnlyWrite;
		this.#setPendingFullWriteDescription = options.setPendingFullWriteDescription;
		this.#ensureGoalRegistered = options.ensureGoalRegistered;
		this.#rebuildSystemPrompt = options.rebuildSystemPrompt;
		this.#getMcpServerInstructions = options.getMcpServerInstructions;
		this.#xdev = options.xdev;
		if (this.#xdev && this.#xdev.tools !== this.#toolRegistry) {
			throw new Error("xd:// state must reference the canonical session tool map");
		}
		if (this.#xdev) this.#xdev.decorateExecution = tool => this.#wrapToolForAcpPermission(tool);
		this.#setActiveToolNames = options.setActiveToolNames;
		this.#baseSystemPrompt = options.baseSystemPrompt;
		this.#skills = options.skills ?? [];
		this.#skillWarnings = options.skillWarnings ?? [];
		this.#skillsSettings = options.skillsSettings;
		this.#skillsReloadable = options.skillsReloadable ?? true;
		// Seed from the construction slate (top-level tools plus xd:// mounts).
		// Left empty, getEnabledToolNames() falls back to live agent.state.tools,
		// so an early reconcile (think/Code Mode after the startup model
		// resolution) landing while the live set is transiently narrow
		// commits that narrow set as the sticky slate — the session keeps almost
		// no tools and the prompt rebuild without `read` empties the skill list.
		for (const tool of host.agent.state.tools) this.#enabledToolNames.add(tool.name);
		for (const name of this.#xdev?.mountedNames ?? []) this.#enabledToolNames.add(name);
		this.#promptModelKey = this.#currentPromptModelKey();
	}

	/** Mutable registry shared with controller hosts that inspect available tools. */
	get registry(): Map<string, AgentTool> {
		return this.#toolRegistry;
	}

	/** Current stable base system prompt. */
	get baseSystemPrompt(): string[] {
		return this.#baseSystemPrompt;
	}

	/** Replaces the controller-owned base prompt without applying it to the agent. */
	setBaseSystemPrompt(prompt: string[]): void {
		this.#baseSystemPrompt = prompt;
	}

	/**
	 * Pushes `base` to the agent as the effective system prompt, unless an active
	 * per-turn {@link #turnSystemPromptOverride} takes precedence. Every base
	 * rebuild applies its result through here so a mid-turn rebuild preserves the
	 * override.
	 */
	#applyAgentSystemPrompt(base: string[]): void {
		this.#host.agent.setSystemPrompt(this.#turnSystemPromptOverride ?? base);
	}

	/**
	 * Registers the per-turn `before_agent_start` system-prompt override and
	 * applies it to the agent. Base rebuilds during the turn preserve it until
	 * {@link clearTurnSystemPromptOverride}.
	 */
	setTurnSystemPromptOverride(prompt: string[]): void {
		this.#turnSystemPromptOverride = prompt;
		this.#host.agent.setSystemPrompt(prompt);
	}

	/** Drops the active per-turn override; later rebuilds fall back to the base prompt. */
	clearTurnSystemPromptOverride(): void {
		this.#turnSystemPromptOverride = undefined;
	}

	/** Skills currently rendered into the system prompt. */
	get skills(): Skill[] {
		return this.#skills;
	}

	/** Diagnostics produced while loading the current skills. */
	get skillWarnings(): SkillWarning[] {
		return this.#skillWarnings;
	}

	/** Settings snapshot used for the current skill discovery. */
	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	/** Drops cached per-session ACP `allow_always`/`reject_always` decisions. */
	clearAcpPermissionDecisions(): void {
		this.#acpPermissionDecisions.clear();
	}

	/** Drops cached ACP decisions and re-wraps active tools after the client changes. */
	refreshAcpPermissionGates(): void {
		this.#acpPermissionDecisions.clear();
		const activeTools = this.getActiveToolNames()
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			.map(tool => this.#wrapToolForAcpPermission(tool));
		this.#host.agent.setTools(activeTools);
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getEnabledToolNames().filter(name => !isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/** Names of tools currently exposed at the top level. */
	getActiveToolNames(): string[] {
		return this.#host.agent.state.tools.map(t => t.name);
	}
	/** Enabled top-level, `xd://`, and Code Mode bridge tool names. */
	getEnabledToolNames(): string[] {
		// Union live xd:// mounts so devices mounted out-of-band (plugins writing
		// to xdev state directly) survive the next apply.
		const mountedNames = this.#xdev?.mountedNames;
		const base = this.#enabledToolNames.size > 0 ? [...this.#enabledToolNames] : this.getActiveToolNames();
		if (!mountedNames || mountedNames.size === 0) return base;
		return [...new Set([...base, ...mountedNames])];
	}

	/** Names currently presented as `xd://` devices. */
	getMountedXdevToolNames(): string[] {
		return [...(this.#xdev?.mountedNames ?? [])];
	}

	/** Whether the edit tool is registered. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	/** Looks up a registered tool by its canonical name or `xd://` alias. */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name) ?? this.#toolRegistry.get(stripXdUrlPrefix(name));
	}

	/** Looks up an enabled tool through the same ACP permission gate as direct calls. */
	getToolForEvalBridge(name: string): AgentTool | undefined {
		if (!this.getEnabledToolNames().includes(name)) return undefined;
		const tool = this.#toolRegistry.get(name);
		return tool ? this.#wrapToolForAcpPermission(tool) : undefined;
	}

	/** Canonical allowlist advertised by and enforced for the eval bridge. */
	getEvalBridgeToolNames(): string[] {
		return this.getEnabledToolNames();
	}

	/** Tools left directly model-visible by the last applied Code Mode partition; undefined when inactive. */
	getCodeModeDirectToolNames(): readonly string[] | undefined {
		return this.#codeModeDirectToolNames;
	}

	#hasCodeModeEvalTransport(): boolean {
		const evalTool = this.#toolRegistry.get("eval") as
			| (AgentTool & { supportsCodeModeTransport?: () => boolean })
			| undefined;
		if (!evalTool) return false;
		// A replacement `eval` that cannot state the capability cannot be assumed
		// to run `tool.<name>()`; demoting the direct surface behind it would
		// leave every other tool unreachable.
		return evalTool.supportsCodeModeTransport?.() ?? false;
	}

	/**
	 * Whether a registry entry came from a built-in factory.
	 *
	 * Resolves `customWireName` aliases too: a built-in tool may present on the
	 * wire under a different name (e.g. `edit` exposes itself as `apply_patch` in
	 * apply_patch mode), and tool cards render the call under that wire name. An
	 * extension registering the literal alias name shadows it — the agent loop
	 * routes exact-name matches ahead of wire aliases — so a registered non-built-in
	 * tool with that name wins and the alias no longer counts as built-in.
	 */
	hasBuiltInTool(name: string): boolean {
		if (this.#builtInToolNames.has(name)) return true;
		if (this.#toolRegistry.has(name)) return false;
		for (const builtInName of this.#builtInToolNames) {
			if (this.#toolRegistry.get(builtInName)?.customWireName === name) return true;
		}
		return false;
	}

	/** Updates source provenance when a live registry entry is replaced or restored. */
	setToolBuiltIn(name: string, builtIn: boolean): void {
		if (builtIn) {
			this.#builtInToolNames.add(name);
		} else {
			this.#builtInToolNames.delete(name);
		}
	}

	/** Whether the live registry entry is owned by the RPC host. */
	hasRpcHostTool(name: string): boolean {
		return this.#rpcHostToolNames.has(name);
	}

	/** Whether the current MCP entry came from the manager snapshot. */
	hasMCPManagerTool(name: string): boolean {
		return this.#mcpManagerToolNames.has(name);
	}

	/** Restores manager ownership after a lifecycle registration rollback. */
	setMCPManagerTool(name: string, managerOwned: boolean): void {
		if (managerOwned) {
			this.#mcpManagerToolNames.add(name);
		} else {
			this.#mcpManagerToolNames.delete(name);
		}
	}

	/** Current extension-owned MCP entry retained across manager refreshes. */
	getExtensionMCPTool(name: string): AgentTool | undefined {
		return this.#extensionMcpTools.get(name);
	}

	/** Updates extension ownership when a lifecycle registration commits or rolls back. */
	setExtensionMCPTool(name: string, tool: AgentTool | undefined): void {
		if (!isMCPToolName(name)) return;
		if (tool) {
			this.#extensionMcpTools.set(name, tool);
			this.#mcpManagerToolNames.delete(name);
		} else {
			this.#extensionMcpTools.delete(name);
		}
	}

	/** Serializes every registry and presentation mutation for this session. */
	runToolRegistryMutation<T>(mutation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.#toolRegistryMutationScope.getStore()) return untilAborted(signal, mutation);
		const serialized = this.#toolRegistryMutationTail.then(() => {
			signal?.throwIfAborted();
			return this.#toolRegistryMutationScope.run(true, mutation);
		});
		const operation = untilAborted(signal, serialized);
		this.#toolRegistryMutationTail = serialized.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	/** Names of every registered tool. */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	/**
	 * Full metadata for every registered tool, including source provenance.
	 *
	 * Backs the `getAllTools()` ExtensionAPI method. Returns {@link ToolInfo}
	 * objects (not bare names) so extensions authored against upstream
	 * `@earendil-works/pi-coding-agent` — which promises `ToolInfo[]` — can read
	 * `sourceInfo.source` unchanged.
	 */
	getAllToolInfos(): ToolInfo[] {
		return Array.from(this.#toolRegistry, ([name, tool]) => {
			const source = this.#builtInToolNames.has(name)
				? "builtin"
				: isMCPToolName(name)
					? "mcp"
					: this.#rpcHostToolNames.has(name)
						? "sdk"
						: "extension";
			const sourceInfo: SourceInfo = {
				path: registeredFilesystemSourcePath(this.#host.extensionRunner(), name) ?? `<${source}:${name}>`,
				source,
				scope: "temporary",
				origin: "top-level",
			};
			return { name, description: tool.description, parameters: tool.parameters, sourceInfo };
		});
	}

	#wrapRuntimeTool(tool: AgentTool): AgentTool {
		const wrapped = wrapToolWithMetaNotice(tool);
		const extensionRunner = this.#host.extensionRunner();
		return extensionRunner ? new ExtensionToolWrapper(wrapped, extensionRunner) : wrapped;
	}

	/** Installs and activates the ephemeral vibe tool set. */
	activateVibeTools(baseToolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const createVibeTools = this.#createVibeTools;
			if (!createVibeTools) {
				throw new Error("Vibe tools are unavailable in this session.");
			}

			const tools = createVibeTools();
			const vibeToolNames = tools.map(tool => tool.name);
			if (new Set(vibeToolNames).size !== vibeToolNames.length) {
				throw new Error("Vibe tool names must be unique.");
			}

			for (const tool of tools) {
				if (this.#toolRegistry.has(tool.name)) continue;
				this.#toolRegistry.set(tool.name, this.#wrapRuntimeTool(tool));
				this.#builtInToolNames.add(tool.name);
				this.#installedVibeToolNames.add(tool.name);
			}

			await this.#applyActiveToolsByName([...new Set([...baseToolNames, ...vibeToolNames])]);
		});
	}

	/** Uninstalls vibe tools and activates the replacement set. */
	deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			this.#uninstallVibeTools();
			await this.#applyActiveToolsByName(nextToolNames);
		});
	}

	/** Removes vibe tools without restoring a source-session snapshot. */
	removeVibeToolsPreservingActive(): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const removed = new Set(this.#installedVibeToolNames);
			this.#uninstallVibeTools();
			const nextEnabled = this.getEnabledToolNames().filter(name => !removed.has(name));
			await this.#applyActiveToolsByName(nextEnabled);
		});
	}

	#uninstallVibeTools(): void {
		for (const name of this.#installedVibeToolNames) {
			this.#toolRegistry.delete(name);
			this.#builtInToolNames.delete(name);
		}
		this.#installedVibeToolNames.clear();
	}

	#getEditModeSession() {
		return {
			settings: this.#host.settings,
			getActiveModelString: () => {
				const model = this.#host.model();
				return model ? formatModelString(model) : undefined;
			},
		} as const;
	}

	/** Resolves the edit mode for the active model and settings. */
	resolveActiveEditMode(): EditMode {
		return resolveEditMode(this.#getEditModeSession());
	}

	#currentPromptModelKey(): string | undefined {
		const activeModel = this.#host.model();
		if (!activeModel) return undefined;
		if (this.#host.settings.get("includeModelInPrompt")) return formatModelString(activeModel);
		return `delegation-bias:${resolveDelegationBias(activeModel)}`;
	}

	/** Rebuilds model-dependent tool prompts after a model change. */
	async syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const currentEditMode = this.resolveActiveEditMode();
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit");
		// The system prompt selects model-specific policy even when it does not display the model id.
		const modelChanged = this.#currentPromptModelKey() !== this.#promptModelKey;
		if (editModeChanged || modelChanged) {
			await this.refreshBaseSystemPrompt();
		}
	}

	/** Whether a model transition crosses a Code Mode presentation boundary. */
	codeModeChangesBetween(previousModel: Model | undefined, nextModel: Model): boolean {
		const enabledToolNames = this.getEnabledToolNames();
		const setting = this.#host.settings.get("providers.openai-codex.codeMode");
		const extraDirectTools = this.#host.settings.get("providers.openai-codex.codeModeDirectTools");
		const resolve = (model: Model | undefined) =>
			resolveCodeMode({
				provider: model?.provider ?? "",
				toolMode: model?.toolMode,
				setting,
				extraDirectTools,
				enabledToolNames,
				evalTransportAvailable: this.#hasCodeModeEvalTransport(),
			});
		const previous = resolve(previousModel);
		const next = resolve(nextModel);
		if (previous.active !== next.active) return true;
		if (!next.active) return false;
		if (previous.directToolNames.size !== next.directToolNames.size) return true;
		for (const name of previous.directToolNames) {
			if (!next.directToolNames.has(name)) return true;
		}
		return false;
	}

	codeModeDirectWireMetadataChanged(): boolean {
		if (this.#codeModeDirectWireSignature === undefined) return false;
		return this.#codeModeDirectWireSignature !== this.#computeCodeModeDirectWireSignature(this.getActiveToolNames());
	}

	#computeCodeModeDirectWireSignature(toolNames: readonly string[]): string {
		let signature = "";
		for (const name of toolNames) {
			const tool = this.#toolRegistry.get(name);
			signature += `${name}\u0000${tool?.customWireName ?? name}\u0001`;
		}
		return signature;
	}

	/** Reapplies the enabled set after model or Code Mode setting changes. */
	reconcileCodeMode(): Promise<void> {
		// Sample inside the lock: an unlocked sample can race a queued apply and
		// re-commit a stale slate.
		return this.runToolRegistryMutation(async () => {
			await this.#applyActiveToolsByName(this.getEnabledToolNames());
		});
	}

	/** Enabled MCP tools in their current presentation partition. */
	getSelectedMCPToolNames(): string[] {
		// Every connected MCP tool is enabled; presentation (top-level vs xd://) is
		// decided by loadMode. Return the enabled MCP tools in the current set.
		return this.getEnabledToolNames().filter(name => isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/**
	 * Wrap a tool with a permission-gate proxy when an ACP client is connected.
	 * Only wraps tools whose name is in PERMISSION_REQUIRED_TOOLS and only when
	 * the bridge exposes `requestPermission`. No-ops for all other cases.
	 *
	 * When the user has explicitly opted into `yolo` / auto-approve behavior (via
	 * the SDK/CLI `autoApprove` flag or a configured `tools.approvalMode: yolo`),
	 * skips the gate unless the per-tool policy explicitly requires a prompt or
	 * deny. The schema default is also `yolo`, so an explicit configuration or
	 * explicit session flag is required: default-config ACP sessions keep the
	 * client-side permission gate.
	 */
	#wrapToolForAcpPermission<T extends AgentTool>(tool: T): T {
		const bridge = this.#host.clientBridge();
		// Match the capability+method gating pattern used by read/write/bash.
		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool;
		if (PERMISSION_REQUIRED_TOOLS[tool.name] !== true) return tool;
		// Skip the gate only on explicit yolo opt-in; honour per-tool policies
		// that require a prompt or deny (matching the normal approval wrapper).
		if (this.#isExplicitAutoApproveMode()) {
			const userPolicies = (this.#host.settings.get("tools.approval") ?? {}) as Record<string, unknown>;
			const toolPolicy = userPolicies[tool.name];
			if (!toolPolicy || toolPolicy === "allow") return tool;
		}
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return target[prop as keyof T];
				return async (
					toolCallId: string,
					args: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					ctx: never,
				) => {
					const permissionIntent = getPermissionIntent(target.name, args);
					if (!permissionIntent) {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					const command =
						target.name === "bash" && args && typeof args === "object" && !Array.isArray(args)
							? stringProperty(args, "command")
							: undefined;
					const commandContent = command
						? [{ type: "content" as const, content: { type: "text" as const, text: `$ ${command}` } }]
						: undefined;
					// Short-circuit on persisted decisions.
					const persisted = this.#acpPermissionDecisions.get(permissionIntent.cacheKey);
					if (persisted === "allow_always") {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					if (persisted === "reject_always") {
						throw new ToolError(`Tool call rejected by user (preference)`);
					}
					if (signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					type PermissionRaceResult =
						| { kind: "permission"; outcome: ClientBridgePermissionOutcome }
						| { kind: "aborted" };
					const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>();
					const onAbort = () => resolveAbort({ kind: "aborted" });
					signal?.addEventListener("abort", onAbort, { once: true });
					let raced: PermissionRaceResult;
					try {
						const permissionPromise = bridge.requestPermission!(
							{
								toolCallId,
								toolName: target.name,
								title: permissionIntent.title,
								...(target.name === "bash" ? { kind: "execute" } : {}),
								status: "pending",
								rawInput: args,
								...(commandContent ? { content: commandContent } : {}),
								locations: extractPermissionLocations(
									args,
									this.#host.sessionManager.getCwd(),
									permissionIntent.paths,
								),
							},
							PERMISSION_OPTIONS,
							signal,
						).then(outcome => ({ kind: "permission" as const, outcome }));
						raced = await Promise.race([permissionPromise, abortPromise]);
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
					if (raced.kind === "aborted" || signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					const outcome = raced.outcome;
					if (outcome.outcome === "cancelled") {
						throw new ToolAbortError("Permission request cancelled");
					}
					const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId);
					if (!selectedOption) {
						throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`);
					}
					if (selectedOption.kind === "allow_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "allow_always");
					} else if (selectedOption.kind === "reject_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "reject_always");
					}
					if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
						throw new ToolError(`Tool call rejected by user (${target.name})`);
					}
					return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
				};
			},
		}) as T;
	}

	#isExplicitAutoApproveMode(): boolean {
		return (
			this.#autoApprove ||
			(this.#host.settings.isConfigured("tools.approvalMode") &&
				this.#host.settings.get("tools.approvalMode") === "yolo")
		);
	}

	/** Applies an enabled tool set and reconciles its `xd://` partition. */
	applyActiveToolsByName(toolNames: string[], forcePromptRefresh = false, signal?: AbortSignal): Promise<void> {
		return this.runToolRegistryMutation(
			() => this.#applyActiveToolsByName(toolNames, forcePromptRefresh, signal),
			signal,
		);
	}

	async #applyActiveToolsByName(toolNames: string[], forcePromptRefresh = false, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		toolNames = normalizeToolNames(toolNames);
		const codeMode = resolveCodeMode({
			provider: this.#host.model()?.provider ?? "",
			toolMode: this.#host.model()?.toolMode,
			setting: this.#host.settings.get("providers.openai-codex.codeMode"),
			extraDirectTools: this.#host.settings.get("providers.openai-codex.codeModeDirectTools"),
			enabledToolNames: toolNames,
			evalTransportAvailable: this.#hasCodeModeEvalTransport(),
		});
		let builtInWriteAvailable = this.#builtInToolNames.has("write");
		const fullWriteSelected =
			toolNames.includes("write") &&
			(this.#presentationPinnedToolNames?.has("write") === true ||
				this.#runtimeSelectedToolNames?.has("write") === true);
		if (fullWriteSelected) {
			const writeRegistration = this.#ensureWriteRegistered?.();
			if (writeRegistration) {
				builtInWriteAvailable = (await untilAborted(signal, writeRegistration)) === true;
				if (builtInWriteAvailable) this.#builtInToolNames.add("write");
			}
		}
		const upgradeDeviceOnlyWrite =
			fullWriteSelected &&
			builtInWriteAvailable &&
			this.#isDeviceOnlyWrite?.() === true &&
			this.#setDeviceOnlyWrite !== undefined &&
			this.#setPendingFullWriteDescription !== undefined;
		// Goal mode may have been enabled after session creation, leaving the
		// registry without `goal`. Register it before resolving the selection so
		// `#enterGoalMode`'s `[...tools, "goal"]` request is honored instead of
		// silently dropped (issue #9444).
		if (toolNames.includes("goal") && !this.#toolRegistry.has("goal")) {
			const goalRegistration = this.#ensureGoalRegistered?.();
			if (goalRegistration) await untilAborted(signal, goalRegistration);
		}
		const selectedTools = toolNames.flatMap(name => {
			const tool = this.#toolRegistry.get(name);
			return tool ? [{ name, tool }] : [];
		});
		const xdevReadAvailable = this.#builtInToolNames.has("read") && selectedTools.some(({ name }) => name === "read");
		const xdevWriteAvailable =
			builtInWriteAvailable &&
			(selectedTools.some(({ name }) => name === "write") || this.#deviceOnlyWriteTransportAvailable);
		const isPresentationPinned = (name: string): boolean =>
			this.#presentationPinnedToolNames?.has(name) === true || this.#runtimeSelectedToolNames?.has(name) === true;
		const mountCandidates = selectedTools.filter(
			({ name, tool }) =>
				this.#xdev !== undefined &&
				xdevReadAvailable &&
				xdevWriteAvailable &&
				!isPresentationPinned(name) &&
				isMountableUnderXdev(tool),
		);
		const mountNames = new Set(mountCandidates.map(({ name }) => name));
		// Demoted tools stay reachable through the eval bridge, so nothing is
		// mounted under xd:// while code mode restricts the direct surface.
		if (codeMode.active) mountNames.clear();
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const { name, tool } of selectedTools) {
			if (mountNames.has(name)) continue;
			tools.push(this.#wrapToolForAcpPermission(tool));
			validToolNames.push(name);
		}

		const pinnedWrite = isPresentationPinned("write");
		const activeDeferrableTool = tools.some(tool => tool.deferrable === true);
		const transportNeeded = mountNames.size > 0 || activeDeferrableTool || this.#host.planModeEnabled();
		if (transportNeeded && !builtInWriteAvailable) {
			const writeRegistration = this.#ensureWriteRegistered?.();
			builtInWriteAvailable = writeRegistration ? (await untilAborted(signal, writeRegistration)) === true : false;
			if (builtInWriteAvailable) this.#builtInToolNames.add("write");
		}
		if (transportNeeded && builtInWriteAvailable) {
			const write = this.#toolRegistry.get("write");
			if (write && !validToolNames.includes("write")) {
				tools.push(this.#wrapToolForAcpPermission(write));
				validToolNames.push("write");
			}
		} else if (
			!pinnedWrite &&
			(this.#presentationPinnedToolNames !== undefined || this.#runtimeSelectedToolNames !== undefined)
		) {
			const writeNameIndex = validToolNames.indexOf("write");
			if (writeNameIndex >= 0 && this.#builtInToolNames.has("write")) validToolNames.splice(writeNameIndex, 1);
			const writeToolIndex = tools.findIndex(tool => tool.name === "write" && this.#builtInToolNames.has("write"));
			if (writeToolIndex >= 0) tools.splice(writeToolIndex, 1);
		}

		let appliedTools = tools;
		let appliedNames = validToolNames;
		let nextCodeModeNamespacesInfo: ToolNamespacesInfo | undefined;
		if (codeMode.active) {
			// The write tool survives demotion only when plan mode or a deferrable
			// tool still needs it as the staging transport.
			if (transportNeeded && validToolNames.includes("write")) codeMode.directToolNames.add("write");
			appliedTools = tools.filter(tool => codeMode.directToolNames.has(tool.name));
			appliedNames = validToolNames.filter(name => codeMode.directToolNames.has(name));
			nextCodeModeNamespacesInfo = buildToolNamespacesInfo({
				tools: validToolNames.flatMap(name => {
					const tool = this.#toolRegistry.get(name);
					if (!tool) return [];
					return [
						{
							name,
							customWireName: tool.customWireName,
							loadMode: "loadMode" in tool && typeof tool.loadMode === "string" ? tool.loadMode : undefined,
							mcpServerName:
								"mcpServerName" in tool && typeof tool.mcpServerName === "string"
									? tool.mcpServerName
									: undefined,
						},
					];
				}),
				directToolNames: codeMode.directToolNames,
			});
		}
		const restrictDeviceOnlyWrite =
			validToolNames.includes("write") &&
			!fullWriteSelected &&
			(this.#presentationPinnedToolNames !== undefined || this.#runtimeSelectedToolNames !== undefined) &&
			builtInWriteAvailable &&
			this.#isDeviceOnlyWrite?.() !== true &&
			this.#setDeviceOnlyWrite !== undefined;
		const restoreDormantDeviceOnlyWrite =
			!validToolNames.includes("write") &&
			this.#deviceOnlyWriteTransportAvailable &&
			this.#isDeviceOnlyWrite?.() !== true &&
			this.#setDeviceOnlyWrite !== undefined;
		const deactivateDeviceOnlyWrite =
			!validToolNames.includes("write") &&
			!this.#deviceOnlyWriteTransportAvailable &&
			this.#isDeviceOnlyWrite?.() === true &&
			this.#setDeviceOnlyWrite !== undefined;
		const previousMounted = new Set(this.#xdev?.mountedNames ?? []);
		const previousActiveToolNames = this.getActiveToolNames();
		const previousEnabledToolNames = this.#enabledToolNames;
		const previousCodeModeDirectToolNames = this.#codeModeDirectToolNames;
		const previousToolPredicateNames = this.#toolPredicateNames;
		this.#enabledToolNames = new Set([...validToolNames, ...mountNames]);
		this.#setMountedNames(mountNames);
		this.#toolPredicateNames = codeMode.active ? [...this.#enabledToolNames] : appliedNames;
		this.#setActiveToolNames?.(this.#toolPredicateNames);
		// The eval tool advertises whatever stays direct, including a plan-mode
		// transport `write`, so the applied partition lands before the rebuild
		// reads the tool descriptions.
		this.#codeModeDirectToolNames = codeMode.active ? appliedNames : undefined;

		let rebuiltSystemPrompt: string[] | undefined;
		let rebuiltSignature: string | undefined;
		let frozenSignature: string | undefined;
		let rebuiltXdevCatalogNames: readonly string[] | undefined;
		try {
			if (restrictDeviceOnlyWrite) this.#setDeviceOnlyWrite?.(true);
			if (upgradeDeviceOnlyWrite) this.#setPendingFullWriteDescription?.(true);
			if (this.#rebuildSystemPrompt) {
				// The provider receives only `appliedNames`, but prompt capability and
				// safety gates must see every enabled tool that remains callable via
				// the Code Mode eval bridge. The rendered tool inventory is restricted
				// to the direct names so the prompt never advertises bridge-only tools
				// as provider-callable functions.
				const promptToolNames = codeMode.active ? [...this.#enabledToolNames] : appliedNames;
				const promptTools = codeMode.active
					? promptToolNames.flatMap(name => {
							const tool = this.#toolRegistry.get(name);
							return tool ? [tool] : [];
						})
					: appliedTools;
				const directToolNames = codeMode.active ? appliedNames : undefined;
				const signature = this.#computeAppliedToolSignature(promptToolNames, promptTools, directToolNames);
				const freezeImplicitPromptRefresh =
					!forcePromptRefresh &&
					signature !== this.#lastAppliedToolSignature &&
					this.#lastAppliedToolSignature !== undefined &&
					this.#host.model()?.thinking?.prefixBinding === true &&
					this.#host.agent.state.messages.some(message => message.role === "assistant");
				if (freezeImplicitPromptRefresh) {
					frozenSignature = signature;
				} else if (forcePromptRefresh || signature !== this.#lastAppliedToolSignature) {
					const built = await untilAborted(
						signal,
						this.#rebuildSystemPrompt(promptToolNames, this.#toolRegistry, { directToolNames }),
					);
					rebuiltSystemPrompt = built.systemPrompt;
					rebuiltSignature = signature;
					rebuiltXdevCatalogNames = built.xdevCatalogNames;
				}
			}
			signal?.throwIfAborted();
		} catch (error) {
			if (restrictDeviceOnlyWrite) this.#setDeviceOnlyWrite?.(false);
			if (upgradeDeviceOnlyWrite) this.#setPendingFullWriteDescription?.(false);
			this.#setMountedNames(previousMounted);
			this.#toolPredicateNames = previousToolPredicateNames;
			this.#setActiveToolNames?.(previousToolPredicateNames ?? previousActiveToolNames);
			this.#enabledToolNames = previousEnabledToolNames;
			this.#codeModeDirectToolNames = previousCodeModeDirectToolNames;
			throw error;
		}

		if (this.#host.isDisposed()) {
			if (restrictDeviceOnlyWrite) this.#setDeviceOnlyWrite?.(false);
			if (upgradeDeviceOnlyWrite) this.#setPendingFullWriteDescription?.(false);
			this.#setMountedNames(previousMounted);
			this.#toolPredicateNames = previousToolPredicateNames;
			this.#setActiveToolNames?.(previousToolPredicateNames ?? previousActiveToolNames);
			this.#enabledToolNames = previousEnabledToolNames;
			this.#codeModeDirectToolNames = previousCodeModeDirectToolNames;
			return;
		}

		try {
			this.#notifyXdevMountDelta(previousMounted);
			this.#host.agent.setTools(appliedTools);
			this.#host.setCodeModeNamespacesInfo?.(nextCodeModeNamespacesInfo);
			this.#codeModeDirectWireSignature = codeMode.active
				? this.#computeCodeModeDirectWireSignature(appliedNames)
				: undefined;
			if (rebuiltSystemPrompt && rebuiltSignature) {
				if (this.#lastAppliedToolSignature !== undefined) this.#host.clearInheritedProviderPromptCacheKey();
				this.#baseSystemPrompt = rebuiltSystemPrompt;
				this.#host.clearMemoryPromotionSnapshot();
				this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
				this.#lastAppliedToolSignature = rebuiltSignature;
				this.#promptModelKey = this.#currentPromptModelKey();
				this.#basePromptXdevNames = new Set(rebuiltXdevCatalogNames);
			} else if (frozenSignature) {
				this.#notifyToolRosterDelta(previousActiveToolNames, appliedNames);
				this.#lastAppliedToolSignature = frozenSignature;
			}
			if (restoreDormantDeviceOnlyWrite) {
				this.#setDeviceOnlyWrite?.(true);
			} else if (upgradeDeviceOnlyWrite || deactivateDeviceOnlyWrite) {
				this.#setDeviceOnlyWrite?.(false);
			}
		} finally {
			if (upgradeDeviceOnlyWrite) this.#setPendingFullWriteDescription?.(false);
		}
	}

	#setMountedNames(names: Iterable<string>): void {
		const mountedNames = this.#xdev?.mountedNames;
		if (!mountedNames) return;
		mountedNames.clear();
		for (const name of names) mountedNames.add(name);
	}

	#notifyToolRosterDelta(previousActiveToolNames: readonly string[], appliedNames: readonly string[]): void {
		const previous = new Set(previousActiveToolNames);
		const current = new Set(appliedNames);
		const addedNames = appliedNames.filter(name => !previous.has(name));
		const removedNames = previousActiveToolNames.filter(name => !current.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return;
		const pending = this.#pendingToolRosterDelta ?? { added: new Set<string>(), removed: new Set<string>() };
		for (const name of addedNames) {
			if (!pending.removed.delete(name)) pending.added.add(name);
		}
		for (const name of removedNames) {
			if (!pending.added.delete(name)) pending.removed.add(name);
		}
		this.#pendingToolRosterDelta = pending.added.size > 0 || pending.removed.size > 0 ? pending : undefined;
	}

	/**
	 * Record a mid-session `xd://` mount delta for the model. Non-MCP mount
	 * churn remains notice-only, leaving the system prompt and provider cache
	 * prefix byte-stable; mounted MCP route changes additionally rebuild the
	 * global route guidance through the applied-tool signature. The delta is NOT
	 * steered immediately — a steered notice landing at a run's stop boundary
	 * (or while the session is idle) forces an unsolicited extra assistant turn
	 * — so it is coalesced into {@link #pendingXdevMountDelta} and rides along
	 * with the next prompt (docs + schema stay one `read xd://<tool>` away).
	 * Full docs join the system prompt opportunistically on a rebuild.
	 */
	#notifyXdevMountDelta(previousMounted: ReadonlySet<string>): void {
		const current = this.#xdev?.mountedNames;
		if (!current) return;
		const addedNames = [...current].filter(name => !previousMounted.has(name));
		const removedNames = [...previousMounted].filter(name => !current.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return;
		// Coalesce against the unannounced delta: an unmount cancels a pending
		// mount the model never learned about, and a remount cancels a pending
		// unmount.
		const pending = this.#pendingXdevMountDelta ?? { added: new Set<string>(), removed: new Set<string>() };
		for (const name of addedNames) {
			if (!pending.removed.delete(name)) pending.added.add(name);
		}
		for (const name of removedNames) {
			if (!pending.added.delete(name)) pending.removed.add(name);
		}
		this.#pendingXdevMountDelta = pending.added.size > 0 || pending.removed.size > 0 ? pending : undefined;
		if (this.#host.settings.get("startup.quiet")) return;
		const parts: string[] = [];
		if (addedNames.length > 0) parts.push(`mounted ${addedNames.join(", ")}`);
		if (removedNames.length > 0) parts.push(`unmounted ${removedNames.join(", ")}`);
		this.#host.emitNotice("info", `xd://: ${parts.join("; ")}`, "xdev");
	}

	/**
	 * Forget the announced-mount baseline for a replaced transcript. Called when
	 * session history is swapped wholesale (`/new`, `switchSession`, `branch`): the
	 * previous transcript's persisted notices no longer apply, so the next notice
	 * re-seeds from the new history and a device reconnecting into it announces
	 * again.
	 *
	 * The pending delta is deliberately preserved: it holds mounts that are still
	 * live but not yet delivered to the model, and `branch()` does not rebuild the
	 * base system prompt, so dropping it would leave the branched transcript
	 * unaware of a still-mounted device that no later refresh would re-queue.
	 */
	resetAnnouncedMounts(): void {
		this.#announcedMounts.clear();
		this.#announcedMountsSeeded = false;
	}

	/**
	 * Seed {@link #announcedMounts} from persisted mount notices the first time a
	 * notice is consumed. On resume the in-memory mount set is rebuilt from
	 * scratch, so without replaying history every already-announced dynamic device
	 * would look freshly mounted and re-announce.
	 */
	#ensureAnnouncedMountsSeeded(): void {
		if (this.#announcedMountsSeeded) return;
		this.#announcedMountsSeeded = true;
		for (const message of this.#host.agent.state.messages) {
			if (message.role !== "custom" || message.customType !== XDEV_MOUNT_NOTICE_MESSAGE_TYPE) continue;
			const details = message.details;
			if (
				isRecord(details) &&
				Array.isArray(details.added) &&
				details.added.every(name => typeof name === "string") &&
				Array.isArray(details.removed) &&
				details.removed.every(name => typeof name === "string")
			) {
				for (const name of details.added) this.#announcedMounts.add(name);
				for (const name of details.removed) this.#announcedMounts.delete(name);
				continue;
			}

			// Releases before structured notice details persisted only the rendered
			// prompt. Replay its two stable inventory sections so the first resume
			// after upgrading does not re-announce every dynamic device once.
			if (typeof message.content !== "string") continue;
			let section: "added" | "removed" | undefined;
			for (const line of message.content.split("\n")) {
				if (line === "These tools became available:") {
					section = "added";
					continue;
				}
				if (line.startsWith("No longer mounted")) {
					section = "removed";
					continue;
				}
				if (line === "Configured inline device docs:" || line === "</system-notice>") break;
				if (line.startsWith("Read `xd://<tool>`")) {
					section = undefined;
					continue;
				}
				if (!section) continue;
				const match = /^- xd:\/\/(\S+?)(?:\s+—|$)/.exec(line);
				const name = match?.[1];
				if (!name) continue;
				if (section === "added") this.#announcedMounts.add(name);
				else this.#announcedMounts.delete(name);
			}
		}
	}

	/** Consumes the hidden notice for provider-visible tool-roster changes. */
	takePendingToolRosterNotice(): CustomMessage<{ added: string[]; removed: string[] }> | undefined {
		const pending = this.#pendingToolRosterDelta;
		if (!pending) return undefined;
		this.#pendingToolRosterDelta = undefined;
		const added = [...pending.added];
		const removed = [...pending.removed];
		return {
			role: "custom",
			customType: TOOL_ROSTER_NOTICE_MESSAGE_TYPE,
			content: prompt.render(toolRosterNoticePrompt, {
				added: added.length > 0 ? added.join(", ") : undefined,
				removed: removed.length > 0 ? removed.join(", ") : undefined,
			}),
			details: { added, removed },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/** Consumes the hidden notice for unannounced `xd://` mount changes. */
	takePendingXdevMountNotice(baseCatalogDelivered: boolean): CustomMessage<XdevMountNoticeDetails> | undefined {
		const pending = this.#pendingXdevMountDelta;
		if (!pending) return undefined;
		this.#pendingXdevMountDelta = undefined;
		this.#ensureAnnouncedMountsSeeded();
		// A pending add for a device the outgoing base prompt already lists in its
		// catalog needs no notice line — but only when the final provider prompt
		// still carries that base catalog. A `before_agent_start` replacement drops
		// it, so its additions must remain in the notice. Record prompt-carried
		// devices announced here, after the final prompt is known and immediately
		// before delivery. The pending delta remains untouched by rebuilds, letting
		// {@link #notifyXdevMountDelta} cancel a mount followed by an unmount before
		// any request is sent (issue #7139 reviews).
		if (baseCatalogDelivered) {
			for (const name of pending.added) {
				if (this.#basePromptXdevNames.has(name)) this.#announcedMounts.add(name);
			}
		}
		// Only announce a net change relative to what the model already knows (from
		// this session and persisted history): a re-mount of an already-announced
		// device — the common resume/reconnect case — and an unmount for a device
		// it was never told about are both suppressed, keeping the provider prompt
		// cache prefix byte-stable across resumes.
		const addedNames = [...pending.added].filter(name => !this.#announcedMounts.has(name));
		const removedNames = [...pending.removed].filter(name => this.#announcedMounts.has(name));
		if (addedNames.length === 0 && removedNames.length === 0) return undefined;
		const summaries = new Map(this.#xdev ? xdevEntries(this.#xdev).map(entry => [entry.name, entry.summary]) : []);
		const added = addedNames.map(name => ({ name, summary: summaries.get(name) ?? "" }));
		const removed = removedNames.map(name => ({ name }));
		const docs = this.#xdev
			? xdevDocsFor(
					this.#xdev,
					new Set(addedNames),
					this.#host.settings.get("tools.xdevDocs"),
					this.#host.settings.get("tools.xdevInlineDevices"),
				)
			: "";
		for (const name of addedNames) this.#announcedMounts.add(name);
		for (const name of removedNames) this.#announcedMounts.delete(name);
		return {
			role: "custom",
			customType: XDEV_MOUNT_NOTICE_MESSAGE_TYPE,
			content: prompt.render(xdevMountNoticePrompt, { added, removed, docs }),
			details: { added: addedNames, removed: removedNames },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}

	/** Rediscovers reloadable skills and refreshes prompt metadata. */
	async refreshSkills(): Promise<void> {
		resetCapabilities();
		if (this.#skillsReloadable) {
			const skillsSettings = this.#host.settings.getGroup("skills");
			const discovered = await loadSkills({
				...skillsSettings,
				cwd: this.#host.sessionManager.getCwd(),
				disabledExtensions: this.#host.settings.get("disabledExtensions") ?? [],
				extensionRoots: this.#host.effectiveExtensionRoots(),
			});
			this.#skills = discovered.skills;
			this.#skillWarnings = discovered.warnings;
			this.#skillsSettings = skillsSettings;

			if (this.#host.agentKind() === "main") {
				setActiveSkills(this.#skills);
			}
		}
		await this.refreshBaseSystemPrompt();
		this.#host.notifyCommandMetadataChanged();
	}

	/** Selects enabled tools, ignoring names absent from the registry. */
	setActiveToolsByName(toolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const normalized = normalizeToolNames(toolNames);
			// Transport-write eligibility keys off the *current* active set: an ordinary
			// selection change should not demote `write` unless it is already active.
			await this.#applyToolPresentation(
				normalized,
				this.#xdev?.mountedNames ?? new Set(),
				this.getActiveToolNames().includes("write"),
			);
		});
	}

	/**
	 * Restore an enabled tool set with its exact top-level versus `xd://` partition.
	 *
	 * Both inputs are required because {@link setActiveToolsByName} only receives the
	 * enabled name list and classifies mounts from the current presentation set.
	 * Rollback/restore callers must pass the snapshotted mounted subset so names that
	 * were top-level stay pinned (`#runtimeSelectedToolNames`) and names that were under
	 * `xd://` remain mount-eligible, even when the live mount set has drifted.
	 *
	 * Names outside `mountedToolNames` are pinned top-level for this application;
	 * names in the mounted subset remain eligible for xdev mounting. Set
	 * `forcePromptRefresh` when an enabled tool's schema or prompt-visible metadata
	 * changed without changing its name or presentation.
	 *
	 * Delegates the actual apply through {@link applyActiveToolsByName} and restores
	 * the prior runtime selection if that apply throws.
	 */
	setActiveToolPresentation(
		toolNames: string[],
		mountedToolNames: string[],
		forcePromptRefresh = false,
		signal?: AbortSignal,
	): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const normalized = normalizeToolNames(toolNames);
			// Restoration targets a snapshot, so write eligibility comes from the
			// *target* set rather than whatever happens to be active mid-rollback.
			await this.#applyToolPresentation(
				normalized,
				new Set(normalizeToolNames(mountedToolNames)),
				normalized.includes("write"),
				forcePromptRefresh,
				signal,
			);
		}, signal);
	}

	/** Restores a non-MCP presentation snapshot while retaining the current MCP selection. */
	restoreNonMCPToolPresentation(nonMCPToolNames: string[], nonMCPMountedToolNames: string[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const currentMCPToolNames = this.getSelectedMCPToolNames();
			const currentMountedMCPToolNames = this.getMountedXdevToolNames().filter(isMCPToolName);
			await this.setActiveToolPresentation(
				[...nonMCPToolNames, ...currentMCPToolNames],
				[...nonMCPMountedToolNames, ...currentMountedMCPToolNames],
			);
		});
	}

	/**
	 * Shared body for {@link setActiveToolsByName} and {@link setActiveToolPresentation}:
	 * pins non-mounted names as the runtime selection (holding `write` back when it is
	 * transport-only) and applies the set, rolling the selection back if apply throws.
	 */
	async #applyToolPresentation(
		normalized: string[],
		mounted: ReadonlySet<string>,
		writeSelected: boolean,
		forcePromptRefresh = false,
		signal?: AbortSignal,
	): Promise<void> {
		const retainedMountedDevice = [...mounted].some(name => normalized.includes(name));
		const retainedDeferrableTool = normalized.some(name => this.#toolRegistry.get(name)?.deferrable === true);
		const deviceOnlyWriteActive = this.#isDeviceOnlyWrite?.() === true;
		const transportWriteActive =
			normalized.includes("write") &&
			this.#builtInToolNames.has("write") &&
			this.#presentationPinnedToolNames?.has("write") !== true &&
			this.#runtimeSelectedToolNames?.has("write") !== true &&
			((this.#host.planModeEnabled() && (!writeSelected || deviceOnlyWriteActive)) ||
				(writeSelected && deviceOnlyWriteActive && (retainedMountedDevice || retainedDeferrableTool)));
		const previousRuntimeSelectedToolNames = this.#runtimeSelectedToolNames;
		this.#runtimeSelectedToolNames = new Set(
			normalized.filter(name => !mounted.has(name) && !(name === "write" && transportWriteActive)),
		);
		try {
			await this.#applyActiveToolsByName(normalized, forcePromptRefresh, signal);
		} catch (error) {
			this.#runtimeSelectedToolNames = previousRuntimeSelectedToolNames;
			throw error;
		}
	}

	/** Replaces memory-backend tools while preserving unrelated selections. */
	replaceMemoryTools(tools: AgentTool[]): Promise<void> {
		return this.runToolRegistryMutation(async () => {
			const removed = new Set<string>(MEMORY_BACKEND_TOOL_NAMES.filter(name => this.#builtInToolNames.has(name)));
			const nextActive = this.getEnabledToolNames().filter(name => !removed.has(name));
			for (const name of removed) {
				this.#toolRegistry.delete(name);
				this.#builtInToolNames.delete(name);
			}

			for (const tool of tools) {
				if (!MEMORY_BACKEND_TOOL_NAMES.some(name => name === tool.name) || this.#toolRegistry.has(tool.name)) {
					continue;
				}
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
				nextActive.push(wrapped.name);
			}
			await this.#applyActiveToolsByName([...new Set(nextActive)]);
		});
	}

	/**
	 * Session-scoped enable/disable for the private `think` scratchpad tool.
	 *
	 * Enabling constructs the tool once and refreshes the model's tool contract;
	 * disabling removes it from the active set while preserving its registry entry.
	 *
	 * @returns false when enabling was requested but this session cannot build the tool.
	 */
	setThinkToolEnabled(enabled: boolean): Promise<boolean> {
		return this.#setThinkToolActive(enabled && supportsExternalThinking(this.#host.model()));
	}

	/** Reconciles the external scratchpad after the active model changes. */
	reconcileThinkTool(): Promise<boolean> {
		return this.#setThinkToolActive(
			this.#host.settings.get("externalThinking") && supportsExternalThinking(this.#host.model()),
		);
	}

	#setThinkToolActive(enabled: boolean): Promise<boolean> {
		return this.runToolRegistryMutation(async () => {
			const active = this.getEnabledToolNames();
			if (!enabled) {
				if (active.includes("think")) {
					await this.#applyActiveToolsByName(active.filter(name => name !== "think"));
				}
				return true;
			}
			if (!this.#toolRegistry.has("think")) {
				const tool = await this.#createThinkTool?.();
				if (tool?.name !== "think") return false;
				const wrapped = this.#wrapRuntimeTool(tool);
				this.#toolRegistry.set(wrapped.name, wrapped);
				this.#builtInToolNames.add(wrapped.name);
			}
			if (!active.includes("think")) {
				await this.#applyActiveToolsByName([...active, "think"]);
			}
			return true;
		});
	}

	/** Rebuilds the stable base prompt for the current tools and model. */
	refreshBaseSystemPrompt(): Promise<void> {
		return this.runToolRegistryMutation(() => this.#refreshBaseSystemPrompt());
	}

	async #refreshBaseSystemPrompt(): Promise<void> {
		if (this.#host.isDisposed() || !this.#rebuildSystemPrompt) return;
		const activeToolNames = this.getActiveToolNames();
		const promptToolNames =
			this.#codeModeDirectWireSignature === undefined ? activeToolNames : this.getEnabledToolNames();
		// Under Code Mode the active names are exactly the direct keep-set.
		const directToolNames = this.#codeModeDirectWireSignature === undefined ? undefined : activeToolNames;
		this.#setActiveToolNames?.(this.#toolPredicateNames ?? activeToolNames);
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const built = await this.#rebuildSystemPrompt(promptToolNames, this.#toolRegistry, { directToolNames });
		if (this.#host.isDisposed()) return;
		this.#baseSystemPrompt = built.systemPrompt;
		this.#basePromptXdevNames = new Set(built.xdevCatalogNames);
		this.#host.clearMemoryPromotionSnapshot();
		if (
			previousBaseSystemPrompt.length !== this.#baseSystemPrompt.length ||
			previousBaseSystemPrompt.some((part, index) => part !== this.#baseSystemPrompt[index])
		) {
			this.#host.clearInheritedProviderPromptCacheKey();
		}
		this.#applyAgentSystemPrompt(this.#baseSystemPrompt);
		this.#promptModelKey = this.#currentPromptModelKey();
		// Refresh the cached signature so a subsequent `applyActiveToolsByName` with
		// the same tool set does not re-rebuild on top of the explicit refresh we
		// just performed (and conversely, a different set forces a fresh rebuild).
		const promptTools = promptToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(promptToolNames, promptTools, directToolNames);
	}

	/** Applies one-turn memory prompt injection before an agent run. */
	async buildSystemPromptForAgentStart(promptText: string): Promise<string[]> {
		const backend = await resolveMemoryBackend(this.#host.settings);
		if (!backend.beforeAgentStartPrompt) return this.#baseSystemPrompt;

		try {
			const injected = await backend.beforeAgentStartPrompt(this.#host.memoryBackendSession(), promptText);
			if (!injected) return this.#baseSystemPrompt;

			const previousBaseSystemPrompt = this.#baseSystemPrompt;
			try {
				await this.refreshBaseSystemPrompt();
			} catch (refreshErr) {
				logger.debug("Memory backend prompt refresh after beforeAgentStartPrompt failed", {
					backend: backend.id,
					error: String(refreshErr),
				});
			}

			if (
				this.#baseSystemPrompt.length !== previousBaseSystemPrompt.length ||
				this.#baseSystemPrompt.some((part, index) => part !== previousBaseSystemPrompt[index])
			) {
				return this.#baseSystemPrompt;
			}

			this.#host.captureMemoryPromotionSnapshot(previousBaseSystemPrompt);
			const stablePrompt = [...previousBaseSystemPrompt, injected];
			this.#baseSystemPrompt = stablePrompt;
			this.#applyAgentSystemPrompt(stablePrompt);
			return stablePrompt;
		} catch (err) {
			logger.debug("Memory backend beforeAgentStartPrompt failed", {
				backend: backend.id,
				error: String(err),
			});
			return this.#baseSystemPrompt;
		}
	}

	/**
	 * Compose a stable signature for the inputs that `rebuildSystemPrompt` reads.
	 * Two calls producing identical signatures are guaranteed to produce identical
	 * system prompt bytes, so the rebuild can be skipped.
	 *
	 * The signature covers:
	 *   1. Active tool names in order (the prompt renders them in this order).
	 *   2. Active tool labels, descriptions, and wire-visible names — all are
	 *      rendered into the prompt body (see `system-prompt.md` `{{label}}: \`{{name}}\``
	 *      and `toolPromptNames` in `buildSystemPrompt`). The wire name comes from
	 *      `tool.customWireName` and overrides the internal name on the model wire
	 *      (e.g. `edit` exposes itself as `apply_patch` to GPT-5 in apply_patch mode);
	 *      a stale wire name would desync prompt guidance from actual tool routing.
	 *   3. The bounded mounted-MCP projection: escaped original-name labels,
	 *      actual `xd://` paths, and the omission flag in catalog order. These are
	 *      the exact values rendered by the global transport guidance; catalog
	 *      churn wholly behind the fallback does not change the prompt.
	 *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
	 *      embeds these in the appended prompt under "## MCP Server Instructions".
	 *      A server upgrade can change instructions while keeping tools identical.
	 *
	 * Settings-driven tool metadata is covered automatically: built-in tools that
	 * depend on settings expose `description`/`label` via getters (see `TaskTool`,
	 * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
	 * call - so a settings flip that mutates the rendered string differs the signature
	 * the next time {@link applyActiveToolsByName} runs. Do not refactor `describeTool`
	 * to cache per-tool strings without preserving this property.
	 *
	 * Inputs NOT covered: tool input schemas; memory instructions read from disk;
	 * and SDK-init-time closure constants in `sdk.ts` (`inlineToolDescriptors`,
	 * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`, `secretsEnabled`). The
	 * closure-captured ones cannot change at runtime regardless of skip behavior.
	 * For everything else, callers must explicitly call {@link refreshBaseSystemPrompt}
	 * after side-effecting changes; see the memory hooks and {@link syncAfterModelChange}.
	 *
	 * The calendar date is deliberately NOT part of the signature: the date/cwd
	 * reminder rides on the first user turn at request time (`date-cwd-reminder`),
	 * so a session spanning midnight must NOT rebuild a prompt that no longer
	 * embeds the date — the reminder picks up the new day on its own.
	 */
	#computeAppliedToolSignature(toolNames: string[], tools: AgentTool[], directToolNames?: readonly string[]): string {
		// Order-preserving join: any reorder must produce a different signature so
		// the rebuild fires and the new tool list reaches the API.
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		const mountedMCPProjection = projectMountedMCPXdevGuidance(
			collectMountedMCPToolRoutes(this.#xdev ? listXdevTools(this.#xdev) : []),
		);
		const mountedMCPRouteSegment =
			JSON.stringify({
				mappings: mountedMCPProjection.mappings.map(mapping => [mapping.label, mapping.path] as const),
				hasOmittedMappings: mountedMCPProjection.hasOmittedMappings,
			}) ?? "{}";
		const serverInstructions = this.#getMcpServerInstructions?.();
		let instructionsSegment = "";
		if (serverInstructions && serverInstructions.size > 0) {
			// Sort by server name so transport flap order does not perturb the signature.
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			entries.sort();
			instructionsSegment = entries.join("\u0006");
		}
		// The non-MCP remainder of the xd:// inventory is deliberately NOT part
		// of the signature: its mount/unmount announces itself through
		// `#notifyXdevMountDelta` rather than rewriting the system prompt, keeping
		// the provider cache prefix byte-stable. Mounted MCP routes are the narrow
		// exception above, bounded to the exact projection rendered in the global
		// route guidance so churn wholly behind its fallback does not rebuild.
		// Direct Code Mode names render the restricted tool inventory, so a
		// `codeModeDirectTools` change must rebuild even when the enabled set is
		// unchanged.
		const directSegment = directToolNames === undefined ? "" : `\u0004${directToolNames.join("\u0001")}`;
		return `${nameSegment}\u0003${descriptionSegment}\u0007${instructionsSegment}\u0008${mountedMCPRouteSegment}${directSegment}`;
	}

	/**
	 * Replace MCP tools in the registry and enable them immediately. Refreshes
	 * are serialized so an older asynchronous prompt rebuild cannot commit
	 * after a newer catalog snapshot. Every connected MCP tool becomes available
	 * (mounted under `xd://` when that transport is active, else top-level).
	 */
	refreshMCPTools(mcpTools: CustomTool[]): Promise<void> {
		const snapshot = [...mcpTools];
		return this.runToolRegistryMutation(() =>
			this.#host.isDisposed() ? Promise.resolve() : this.#applyMCPToolRefresh(snapshot),
		);
	}

	async #applyMCPToolRefresh(mcpTools: CustomTool[]): Promise<void> {
		const previousMcpTools = new Map<string, AgentTool>();
		for (const [name, tool] of this.#toolRegistry) {
			if (isMCPToolName(name)) previousMcpTools.set(name, tool);
		}
		const previousMcpManagerToolNames = new Set(this.#mcpManagerToolNames);
		const previousActiveMcpToolNames = this.getEnabledToolNames().filter(isMCPToolName);
		const restorePreviousMcpTools = () => {
			for (const name of this.#toolRegistry.keys()) {
				if (isMCPToolName(name)) this.#toolRegistry.delete(name);
			}
			for (const [name, tool] of previousMcpTools) this.#toolRegistry.set(name, tool);
			this.#mcpManagerToolNames = previousMcpManagerToolNames;
		};

		const getCustomToolContext = (): CustomToolContext => ({
			sessionManager: this.#host.sessionManager,
			modelRegistry: this.#host.modelRegistry,
			model: this.#host.model(),
			isIdle: () => !this.#host.isStreaming(),
			hasQueuedMessages: () => this.#host.queuedMessageCount() > 0,
			abort: () => {
				this.#host.agent.abort();
			},
			settings: this.#host.settings,
			localProtocolOptions: this.#host.localProtocolOptions(),
		});

		const extensionRunner = this.#host.extensionRunner();
		const managerTools = deduplicateMCPToolsByName(mcpTools).map(customTool => {
			const wrapped = wrapToolWithMetaNotice(CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool);
			return (extensionRunner ? new ExtensionToolWrapper(wrapped, extensionRunner) : wrapped) as AgentTool;
		});
		const managerToolSet = new Set(managerTools);
		const reconciledTools = deduplicateMCPToolsByName([...this.#extensionMcpTools.values(), ...managerTools]);

		for (const name of this.#toolRegistry.keys()) {
			if (isMCPToolName(name)) this.#toolRegistry.delete(name);
		}
		this.#mcpManagerToolNames.clear();
		for (const tool of reconciledTools) {
			this.#toolRegistry.set(tool.name, tool);
			if (managerToolSet.has(tool)) this.#mcpManagerToolNames.add(tool.name);
		}

		// Connected manager tools become active immediately. Extension-owned MCP
		// tools retain their prior selection while both sets share one registry.
		const retainedActiveExtensionToolNames = previousActiveMcpToolNames.filter(
			name => this.#extensionMcpTools.has(name) && this.#toolRegistry.has(name),
		);
		const nextActive = [
			...new Set([
				...this.#getActiveNonMCPToolNames(),
				...this.#mcpManagerToolNames,
				...retainedActiveExtensionToolNames,
			]),
		];
		try {
			await this.#applyActiveToolsByName(nextActive);
			if (this.#host.isDisposed()) restorePreviousMcpTools();
		} catch (error) {
			restorePreviousMcpTools();
			throw error;
		}
	}

	/** Replaces RPC host-owned tools and refreshes the active set before the next model call. */
	refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const snapshot = [...rpcTools];
		return this.runToolRegistryMutation(() => this.#applyRpcHostToolRefresh(snapshot));
	}

	async #applyRpcHostToolRefresh(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getEnabledToolNames();
		const previousRpcHostTools = new Map(
			[...previousRpcHostToolNames].flatMap(name => {
				const tool = this.#toolRegistry.get(name);
				return tool ? [[name, tool] as const] : [];
			}),
		);
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		const extensionRunner = this.#host.extensionRunner();
		for (const tool of rpcTools) {
			const metaWrapped = wrapToolWithMetaNotice(tool);
			const finalTool = (
				extensionRunner ? new ExtensionToolWrapper(metaWrapped, extensionRunner) : metaWrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		try {
			await this.#applyActiveToolsByName(
				Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
			);
		} catch (error) {
			for (const name of this.#rpcHostToolNames) this.#toolRegistry.delete(name);
			this.#rpcHostToolNames = previousRpcHostToolNames;
			for (const [name, tool] of previousRpcHostTools) this.#toolRegistry.set(name, tool);
			throw error;
		}
	}
}

function registeredFilesystemSourcePath(runner: ExtensionRunner | undefined, name: string): string | undefined {
	const registered = runner?.getRegisteredTool(name);
	if (!registered) return undefined;
	const candidate = registered.definition.sourcePath ?? registered.extensionPath;
	return candidate && isFilesystemSourcePath(candidate) ? candidate : undefined;
}
