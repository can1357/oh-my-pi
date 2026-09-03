import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";
import { MAIN_AGENT_RULE_NAME, SUB_AGENT_RULE_NAME } from "../capability/rule";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { MCPManager } from "../mcp/manager";
import { initializeExtensions } from "../modes/runtime-init";
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import type { EventBus } from "../utils/event-bus";
import { attachIrcWakeTurnMonitor, createMCPProxyTools, createSubagentSettings } from "./executor";
import type { AgentDefinition } from "./types";

/**
 * Ambient context the reviver needs at revive time. The top-level session is
 * kept LIVE (cwd / artifact manager read on demand) so a later `/new` or cwd
 * move is followed rather than snapshotted; auth/models/settings are
 * process-stable and captured by reference.
 */
export interface PersistedSubagentReviveContext {
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** LSP policy of the top-level session; revived subagents inherit it rather than defaulting on. */
	enableLsp: boolean;
	/**
	 * Shared event bus feeding RPC/collab subagent subscriptions. Passed through
	 * to the wake-turn monitor so an IRC send to a cold-revived subagent emits
	 * the same lifecycle/progress frames a live run does.
	 */
	eventBus?: EventBus;
	/** Root-scoped observability bus the revived run's frames also publish to. */
	subagentEventBus?: EventBus;
}

/**
 * Build the factory the {@link AgentLifecycleManager} uses to cold-revive a
 * `parked` subagent ref restored from disk (Agent Hub scan, collab mirror, or a
 * resumed process). Such a ref carries a sessionFile but no in-memory adoption —
 * the executor's live reviver closure died with the process/turn that spawned
 * it — so `ensureLive` (IRC sends, hub focus) would otherwise refuse it.
 *
 * This rebuilds the subagent the same way `--resume` rebuilds a session: reopen
 * the JSONL and replay it through {@link createAgentSession}. The catch is that
 * resume restores only conversation/model from the file — the runtime contract
 * (tools / system prompt / output schema / kind) is built from options, so a
 * bare reopen would resurrect a wrong (top-level) session. We source that
 * contract from the persisted `session_init` entry instead, and mirror the
 * executor's subagent wiring (MCP proxy tools, depth-derived gating,
 * yield-required, active-tool clamp, registry status sync).
 */
export function createPersistedSubagentReviverFactory(
	ctx: PersistedSubagentReviveContext,
): PersistedSubagentReviverFactory {
	const registry = AgentRegistry.global();
	return async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const peek = await SessionManager.peekSessionInit(sessionFile);
		// No persisted contract (pre-session_init file) or the recorded workspace
		// is gone (isolated/merged worktree, moved dir): leave it transcript-only
		// (history://) rather than resurrect a wrong or broken session.
		if (!peek?.init) return undefined;
		try {
			await fs.stat(peek.cwd);
		} catch {
			return undefined;
		}
		const init = peek.init;
		// taskDepth drives real capability gating (task-spawn allowance, memory
		// startup, …); derive it from the persisted parent chain rather than
		// assuming a fixed level.
		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			seen.add(parentId);
			taskDepth++;
			parentId = registry.get(parentId)?.parentId;
		}
		// Rebuild the same advisor opt-in the original spawn resolved: `"on"` =
		// advisor-role model, anything else = the explicit pattern stamped onto
		// this session's `modelRoles.advisor`. Absent = unadvised (the
		// createSubagentSettings default).
		const subagentSettings = createSubagentSettings(ctx.settings, {
			...(init.readSummarize === false ? { "read.summarize.enabled": false } : undefined),
			...(init.advisor
				? {
						"advisor.enabled": true,
						...(init.advisor !== "on"
							? { modelRoles: { ...ctx.settings.getModelRoles(), advisor: init.advisor } }
							: undefined),
					}
				: undefined),
		});
		const persistedModelPattern =
			init.modelRole && init.modelRole !== "default"
				? [formatModelRoleAlias(init.modelRole), ...(init.resolvedModel ? [init.resolvedModel] : [])]
				: init.resolvedModel;
		// Older session files persisted the synthetic xd:// write transport in the
		// enabled set. A read-only agent definition could never grant full write,
		// so remove that transport name before replaying tools as explicit grants.
		const revivedToolNames =
			init.readOnly === true && init.tools.includes("write")
				? init.tools.filter(name => name !== "write")
				: init.tools;
		return async expectedRef => {
			// Re-open fresh on every revive: park closes the writer, so this takes
			// the single-writer lock cleanly and restores the full message history.
			const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				suppressBreadcrumb: true,
			});
			const artifactManager = ctx.session.sessionManager.getArtifactManager();
			if (artifactManager) reopened.adoptArtifactManager(artifactManager);
			// A restricted persisted contract must not consult process-global MCP
			// state: same-name MCP tools are untrusted capability sources.
			const restrictToolNames = init.restrictToolNames === true;
			const mcpManager = restrictToolNames ? undefined : MCPManager.instance();
			const mcpProxyTools = mcpManager ? createMCPProxyTools(mcpManager) : [];
			const { session } = await createAgentSession({
				cwd: ctx.session.sessionManager.getCwd(),
				authStorage: ctx.authStorage,
				// Revived agents join the root session tree, so their observability
				// frames ride the same bus the RPC/collab surfaces subscribed to.
				subagentEventBus: ctx.subagentEventBus,
				modelRegistry: ctx.modelRegistry,
				...(persistedModelPattern ? { modelPattern: persistedModelPattern } : {}),
				modelPatternAuthFallback: init.resolvedModel,
				settings: subagentSettings,
				sessionManager: reopened,
				agentId: ref.id,
				agentDisplayName: ref.displayName,
				// `agents` rule scoping keys on the durable definition name (`scout`,
				// `reviewer`, …), not the registry display label — cold-revived refs
				// register with `displayName: id` (registry/persisted-agents.ts), so a
				// generated task id would silently drop every agent-scoped rule.
				// `init.agent` carries the real name; only files predating that field
				// fall back to the display label. A parked transcript may also predate
				// the `main`/`sub` definition-name reservation (discovery/helpers.ts): a
				// persisted `init.agent` of either sentinel value from such a legacy
				// custom agent must not masquerade as that sentinel here, so it falls
				// back to the display label too, keeping it scoped as an ordinary
				// subagent under its generated id instead of `main` or the shared `sub`
				// bucket.
				agentName:
					init.agent &&
					init.agent.trim().toLowerCase() !== MAIN_AGENT_RULE_NAME &&
					init.agent.trim().toLowerCase() !== SUB_AGENT_RULE_NAME
						? init.agent
						: ref.displayName,
				parentTaskPrefix: ref.id,
				parentAgentId: ref.parentId,
				expectedAgentRef: expectedRef,
				taskDepth,
				toolNames: revivedToolNames,
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				restrictToolNames: restrictToolNames || undefined,
				requireYieldTool: true,
				systemPrompt: () => [init.systemPrompt],
				// Old files predate persisted spawns: deny re-spawning rather than let
				// createAgentSession default to wildcard ("*").
				spawns: init.spawns ?? "",
				hasUI: false,
				enableLsp: restrictToolNames ? false : ctx.enableLsp,
				...(restrictToolNames
					? {
							enableIrc: false,
							enableMCP: false,
							preloadedExtensionPaths: [],
							preloadedPreparedExtensions: [],
							preloadedCustomToolPaths: [],
						}
					: {
							enableMCP: !mcpManager,
							mcpManager,
							customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
						}),
			});
			// Clamp the active set to the persisted list: createAgentSession's
			// `alwaysInclude` can re-add non-defaultInactive extension/custom tools
			// the original run didn't carry. Unknown/missing names are ignored.
			await session.setActiveToolsByName([...revivedToolNames, ...session.getMountedXdevToolNames()]);
			// Wire the extension runtime exactly as the live executor does. Without
			// this the runner stays pre-init, every action method throws
			// `ExtensionRuntimeNotInitializedError`, and a `tool_call` handler that
			// touches a runtime action trips the fail-closed gate in `emitToolCall`,
			// blocking every tool — including the hidden `yield` — in the revived
			// agent. `session_start` also re-runs so extensions restore per-session
			// state (issue #8824).
			await initializeExtensions(session, {
				reportSendError: (action, err) => logger.error("Extension send failed", { action, error: err.message }),
				reportRuntimeError: err => logger.error("Extension error", { path: err.extensionPath, error: err.error }),
			});
			// Cold revives must drive registry status themselves — createAgentSession
			// doesn't wire this generically (the live path does it in the executor).
			// The internal run-state signal precedes deferrable public `agent_end`,
			// keeping idle-TTL ownership synchronized even while prompts unwind.
			registry.syncSessionStatus(ref.id, session);
			// Persisted files predate an agent-source field, so cold-revived frames
			// report the runtime-neutral `user` source; name comes from the ref.
			const wakeAgent: AgentDefinition = {
				name: ref.displayName,
				description: "",
				systemPrompt: init.systemPrompt,
				source: "user",
			};
			attachIrcWakeTurnMonitor(session, {
				id: ref.id,
				agent: wakeAgent,
				eventBus: ctx.eventBus,
				subagentEventBus: ctx.subagentEventBus,
				sessionFile,
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				artifactsDir: ctx.session.sessionFile?.slice(0, -6),
			});
			return session;
		};
	};
}
