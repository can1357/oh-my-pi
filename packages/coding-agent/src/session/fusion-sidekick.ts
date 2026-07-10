import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { modelsAreEqual } from "@pk-nerdsaver-ai/pi-catalog/models";
import { logger, prompt, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { formatModelString, getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { LocalProtocolOptions } from "../internal-urls";
import type { MCPManager } from "../mcp/manager";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import fusionSidekickBootstrapPrompt from "../prompts/fusion/sidekick-bootstrap.md" with { type: "text" };
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import * as taskDiscovery from "../task/discovery";
import * as taskExecutor from "../task/executor";
import { AgentOutputManager } from "../task/output-manager";
import type { EventBus } from "../utils/event-bus";
import type { AgentSession } from "./agent-session";
import type { ArtifactManager } from "./artifacts";
import type { SessionManager } from "./session-manager";

/** Minimal interface a host must satisfy to own a Fusion sidekick lifecycle. */
export interface FusionSidekickHost {
	session: AgentSession;
	settings: Settings;
	sessionManager: SessionManager;
	mcpManager?: MCPManager;
	eventBus?: EventBus;
}

/** Result of reconcileFusionSidekickModel. */
export interface ReconcileResult {
	note: string;
	sidekickLive: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn (or verify) a warm Fusion sidekick for `host`.
 *
 * Idempotent when a spawn already succeeded (guards against double-spawn on the
 * same host).  `force: true` releases any recorded sidekick id first, then
 * re-spawns — used after a session switch where the old tracked id is stale.
 *
 * Best-effort: failures only warn; the main agent keeps running without a
 * sidekick and the delegation prompt falls back to a fresh `task` subagent.
 */
export async function ensureFusionSidekick(host: FusionSidekickHost, options: { force?: boolean } = {}): Promise<void> {
	const { session, settings } = host;
	try {
		const fusionEnabled = settings.get("fusion.enabled") === true && settings.get("fusion.mode") !== "off";
		if (!fusionEnabled) {
			if (options.force) session.setFusionSidekickId(undefined);
			return;
		}
		if (!options.force) {
			// Idempotent only while the recorded id still resolves in the registry.
			// A stale id (spawn failed after allocate, or the sidekick aborted) must
			// not latch forever — clear it and fall through to respawn.
			const existingId = session.getFusionSidekickId();
			if (existingId) {
				const ref = AgentRegistry.global().get(existingId);
				if (ref && ref.status !== "aborted") return;
				session.setFusionSidekickId(undefined);
			}
		} else {
			// Session switch: release the stale ref so Agent Hub doesn't accumulate
			// Sidekick-2, -3, … on every switch.
			const staleId = session.getFusionSidekickId();
			if (staleId && AgentRegistry.global().get(staleId)) {
				try {
					await AgentLifecycleManager.global().release(staleId);
				} catch (err) {
					logger.warn("Fusion sidekick release failed", { id: staleId, error: String(err) });
				}
			}
			session.setFusionSidekickId(undefined);
		}

		const sidekickModel = settings.get("fusion.sidekickModel") || "pi/smol";
		const sidekickId = await spawnFusionSidekick(host, sidekickModel);
		if (sidekickId) {
			session.setFusionSidekickId(sidekickId);
		} else {
			// Spawn returned "" (agent type unavailable) — leave id unset so a later
			// call (e.g. user runs `/fusion on` mid-session) can retry.
			logger.warn("Fusion sidekick spawn returned empty id", { sidekickModel });
		}
	} catch (err) {
		logger.warn("Fusion sidekick spawn failed", { error: String(err) });
	}
}

/**
 * Reconcile a changed `fusion.sidekickModel` with the tracked sidekick.
 *
 * Returns a user-facing note and whether a live sidekick now exists.
 * - A live idle sidekick is retargeted in place (non-ephemeral; survives
 *   park/revive so the user's explicit reassignment is its permanent identity).
 * - A parked or dead sidekick is released (no accumulation) and replaced.
 * - A mid-turn sidekick is left alone; the new model applies on its next turn.
 */
export async function reconcileFusionSidekickModel(host: FusionSidekickHost): Promise<ReconcileResult> {
	const { session, settings } = host;
	if (settings.get("fusion.enabled") !== true || settings.get("fusion.mode") === "off") {
		return { note: "", sidekickLive: false };
	}

	const id = session.getFusionSidekickId();
	const live = id ? AgentRegistry.global().get(id)?.session : undefined;
	if (live) {
		const selector = settings.get("fusion.sidekickModel") || "pi/smol";
		const target = resolveModelRoleValue(selector, session.modelRegistry.getAvailable() as Model<Api>[], {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
			modelRegistry: session.modelRegistry,
		}).model;
		if (!target) {
			return {
				note: "Live sidekick unchanged: selector does not resolve to an available model.",
				sidekickLive: true,
			};
		}
		if (live.model && modelsAreEqual(target, live.model)) {
			return { note: "Live sidekick is already on this model.", sidekickLive: true };
		}
		if (!session.modelRegistry.hasConfiguredAuth(target)) {
			return {
				note: "Live sidekick unchanged: no configured auth for the target model.",
				sidekickLive: true,
			};
		}
		if (live.isStreaming) {
			return {
				note: "Sidekick is mid-turn; it keeps its current model — the new one applies on its next spawn or route.",
				sidekickLive: true,
			};
		}
		// Deliberately NOT ephemeral: an explicit user reassignment is the sidekick's
		// new identity and must survive park/revive. The compaction-route re-tiering
		// in #applyFusionSidekickRoute stays ephemeral by design.
		await live.setModelTemporary(target);
		return { note: "Live sidekick retargeted in place (warm context preserved).", sidekickLive: true };
	}

	// Parked or dead: release the stale ref (no accumulation) and respawn.
	if (id && AgentRegistry.global().get(id)) {
		try {
			await AgentLifecycleManager.global().release(id);
		} catch (error) {
			logger.warn("Fusion sidekick release failed", { id, error: String(error) });
		}
	}
	session.setFusionSidekickId(undefined);
	await ensureFusionSidekick(host);
	const newId = session.getFusionSidekickId();
	return {
		note: newId
			? "Started a fresh sidekick on the new model (previous one was parked or gone)."
			: "Sidekick spawn is pending; the new model applies when it comes up.",
		sidekickLive: !!newId,
	};
}

// ---------------------------------------------------------------------------
// Internal spawn machinery
// ---------------------------------------------------------------------------

async function spawnFusionSidekick(host: FusionSidekickHost, sidekickModel: string): Promise<string> {
	const { session, settings, sessionManager, mcpManager, eventBus } = host;

	const { agents } = await taskDiscovery.discoverAgents(sessionManager.getCwd());
	const agent = taskDiscovery.getAgent(agents, "task");
	if (!agent) {
		logger.warn("Fusion sidekick: task agent unavailable");
		return "";
	}

	await sessionManager.ensureOnDisk();
	const cwd = sessionManager.getCwd();
	const parentSessionFile = sessionManager.getSessionFile() ?? null;
	const persistedArtifactsDir = sessionManager.getArtifactsDir();
	const tempArtifactsDir = persistedArtifactsDir ? null : path.join(os.tmpdir(), `omp-subagent-${Snowflake.next()}`);
	const artifactsDir = persistedArtifactsDir ?? tempArtifactsDir;
	if (!artifactsDir) {
		logger.warn("Fusion sidekick: no artifact directory available");
		return "";
	}
	await fs.mkdir(artifactsDir, { recursive: true });

	const outputManager = new AgentOutputManager(() => artifactsDir);
	const id = await outputManager.allocate("Sidekick");

	const localProtocolOptions: LocalProtocolOptions = {
		getArtifactsDir: () => sessionManager.getArtifactsDir() ?? artifactsDir,
		getSessionId: () => sessionManager.getSessionId(),
	};

	const planModeState = session.getPlanModeState();
	const planReference = planModeState?.enabled
		? undefined
		: await loadOverallPlanReference(session.getPlanReferencePath(), localProtocolOptions);

	const parentAgentId = session.getAgentId() ?? MAIN_AGENT_ID;

	const runPromise = taskExecutor.runSubprocess({
		cwd,
		agent,
		task: prompt.render(subagentUserPromptTemplate, { assignment: fusionSidekickBootstrapPrompt.trim() }),
		assignment: fusionSidekickBootstrapPrompt.trim(),
		description: fusionSidekickBootstrapPrompt.trim(),
		role: "Sidekick",
		index: 0,
		id,
		detached: true,
		fusionSidekick: true,
		modelOverride: sidekickModel,
		outputSchema: {
			type: "object",
			properties: {
				ready: { type: "boolean", const: true },
			},
			required: ["ready"],
		},
		parentActiveModelPattern: session.model ? formatModelString(session.model as Model<Api>) : undefined,
		thinkingLevel: ThinkingLevel.Inherit,
		taskDepth: 0,
		sessionFile: parentSessionFile,
		persistArtifacts: !!persistedArtifactsDir,
		artifactsDir,
		enableLsp: settings.get("task.enableLsp"),
		eventBus,
		authStorage: session.modelRegistry.authStorage,
		modelRegistry: session.modelRegistry,
		settings,
		mcpManager,
		skills: [...session.skills],
		promptTemplates: [...session.promptTemplates],
		localProtocolOptions,
		parentArtifactManager: (sessionManager.getArtifactManager() ?? undefined) as ArtifactManager | undefined,
		parentAgentId,
		color: undefined,
		planReference,
	});

	// Detached runs keep going after bootstrap, but we must not retain an id
	// until createAgentSession has registered the sidekick. Otherwise a failed
	// spawn latches a phantom Sidekick and blocks retries.
	const registered = await waitForSidekickRegistration(id, runPromise);
	if (!registered) {
		logger.warn("Fusion sidekick failed before registry registration", { id, sidekickModel });
		void runPromise.catch(err => {
			logger.error("Fusion sidekick run failed", { id, error: String(err) });
		});
		return "";
	}

	void runPromise.catch(err => {
		logger.error("Fusion sidekick run failed", { id, error: String(err) });
	});
	return id;
}

/** Poll until the sidekick appears in AgentRegistry, or the spawn promise rejects first. */
async function waitForSidekickRegistration(
	id: string,
	runPromise: Promise<unknown>,
	timeoutMs = 30_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let settled: { ok: boolean } | undefined;
	void runPromise.then(
		() => {
			settled = { ok: true };
		},
		() => {
			settled = { ok: false };
		},
	);

	while (Date.now() < deadline) {
		if (AgentRegistry.global().get(id)) return true;
		if (settled) return settled.ok ? AgentRegistry.global().get(id) !== undefined : false;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	return AgentRegistry.global().get(id) !== undefined;
}
