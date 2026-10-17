import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger } from "@oh-my-pi/pi-utils";
import { formatModelString } from "../config/model-resolver";
import type {
	ExtensionModeControls,
	ModeOperation,
	ModeRequest,
	ModeResult,
	ModeSnapshot,
	SessionModeName,
} from "../extensibility/extensions/mode-api";
import { cfgGoalEnabled } from "../goals/settings";
import { goalFromModeData } from "../goals/state";
import { cfgPlanEnabled } from "../plan-mode/settings";
import planProposalHeadlessPrompt from "../prompts/system/plan-proposal-headless.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { VibeSessionRegistry, type VibeOwnerScope, type VibeParentSession } from "../vibe/runtime";

export interface SessionModeHost {
	/** Host-owned proposal approval, separate from lifecycle entry and exit. */
	onPlanEntered?: () => void;
	onChanged?: (state: ModeSnapshot) => void | Promise<void>;
	goal?: (request: Extract<ModeRequest, { mode: "goal" }>) => Promise<void>;
	settled?: () => Promise<void>;
	usePlanRole?: boolean;
	reconcile?: (options?: { preserveActiveGoal?: boolean }) => Promise<void>;
}

const OPERATIONS: Record<SessionModeName, readonly ModeOperation[]> = {
	plan: ["enter", "exit", "pause", "resume"],
	vibe: ["enter", "exit"],
	goal: ["enter", "replace", "exit", "pause", "resume", "drop", "budget"],
	loop: [],
};

/** Non-interactive lifecycle owner; prompt/review/continuation policy remains with the host. */
export class SessionModeController implements ExtensionModeControls {
	readonly #session: AgentSession;
	#host: SessionModeHost;
	#planPreviousOnSwitch:
		| { tools: string[]; mounted: string[]; model?: Model; thinking?: ConfiguredThinkingLevel }
		| undefined;
	#transitioning = false;
	#revision = 0;
	#last: ModeSnapshot;
	#planPaused = false;
	#planDraft: string | undefined;
	#planWorkflow: "parallel" | "iterative" | undefined;
	#planPrevious: { tools: string[]; mounted: string[]; model?: Model; thinking?: ConfiguredThinkingLevel } | undefined;
	#goalPrevious: string[] | undefined;
	#vibePrevious: string[] | undefined;
	#vibeScope: VibeOwnerScope | undefined;
	#unsubscribe: () => void;
	#disposed = false;

	constructor(session: AgentSession, host: SessionModeHost = {}) {
		this.#session = session;
		this.#host = host;
		this.#last = this.getState();
		this.#unsubscribe = session.subscribe(event => {
			if (this.#transitioning || this.#disposed) return;
			if (this.#host.goal && event.type === "goal_updated" && event.state?.mode === "exiting") return;
			if (event.type === "goal_updated" || event.type === "agent_end") {
				void this.#settleGoal().catch(error => logger.warn("Mode reconciliation failed", { error: String(error) }));
			}
		});
	}

	setHost(host: SessionModeHost): void {
		this.#host = host;
	}

	getState(): ModeSnapshot {
		if (this.#transitioning) return structuredClone(this.#last);
		const plan = this.#session.getPlanModeState();
		const goal = this.#session.getGoalModeState();
		const subagent = this.#session.getAgentKind() === "sub";
		return structuredClone({
			sessionId: this.#session.sessionManager.getSessionId(),
			revision: this.#revision,
			plan: {
				status: plan?.enabled ? "active" : this.#planPaused ? "paused" : "inactive",
				planFilePath: plan?.planFilePath ?? this.#planDraft,
				workflow: plan?.workflow ?? (this.#planPaused ? this.#planWorkflow : undefined),
			},
			vibe: { status: this.#session.getVibeModeState()?.enabled ? "active" : "inactive" },
			goal: {
				status: goal?.enabled ? "active" : goal?.goal.status === "paused" ? "paused" : "inactive",
				state: goal,
			},
			loop: { status: "inactive" },
			capabilities: subagent || this.#disposed ? { plan: [], vibe: [], goal: [], loop: [] } : OPERATIONS,
		} satisfies ModeSnapshot);
	}

	async set(request: ModeRequest): Promise<ModeResult> {
		const before = this.getState();
		const fail = (
			code: Extract<ModeResult, { ok: false }>["code"],
			message: string,
			conflictingMode?: SessionModeName,
		): ModeResult => ({ ok: false, code, message, state: this.getState(), conflictingMode });
		if (!request || typeof request !== "object" || !Object.hasOwn(before.capabilities, request.mode))
			return fail("invalid_request", "Choose plan, vibe, goal, or loop and an explicit action.");
		if (!before.capabilities[request.mode].includes(request.action))
			return fail("unsupported", `${request.mode}.${request.action} is not supported by this host.`);
		if (
			this.#transitioning ||
			this.#session.isSessionTransitioning ||
			// Full snapshot-busy predicate (TUI parity): covers streaming, bash/eval,
			// compaction, handoff, and retry — not just streaming.
			this.#session.isBusyForSnapshot ||
			// goal_updated handlers run inside the accounting lock; a nested
			// mutation would wait on the same tail and deadlock.
			this.#session.goalRuntime.mutationInFlight ||
			// An admitted submission about to start a turn is busy — except when the
			// admitted work IS this extension's command handler, which legitimately
			// runs `ctx.modes.set()` before its own turn (`/mission` pattern).
			(this.#session.hasAdmittedSubmission && !this.#session.isInSoleExtensionCommandDispatch)
		)
			return fail("busy", "Wait for the current turn or mode/session transition to finish, then retry.");
		const validation = this.#validate(request);
		if (validation) return fail("invalid_request", validation);
		if (request.action === "enter" || request.action === "resume" || request.action === "replace") {
			if (request.mode === "plan" && !cfgPlanEnabled.get(this.#session.settings))
				return fail("disabled", "Enable plan.enabled before entering plan mode.");
			if (request.mode === "goal" && !cfgGoalEnabled.get(this.#session.settings))
				return fail("disabled", "Enable goal.enabled before entering goal mode.");
			for (const other of ["plan", "vibe", "goal"] as const) {
				if (other !== request.mode && before[other].status !== "inactive")
					return fail("conflict", `Exit ${other} mode before entering ${request.mode}.`, other);
			}
		}
		this.#transitioning = true;
		let error: unknown;
		try {
			await this.#apply(request);
		} catch (caught) {
			error = caught;
		} finally {
			this.#transitioning = false;
		}
		const committed = this.#publish();
		if (this.#session.sessionManager.getSessionId() !== before.sessionId)
			return fail(
				"session_changed",
				"The session changed during the transition; inspect current state before retrying.",
			);
		if (error !== undefined) return fail("failed", error instanceof Error ? error.message : String(error));
		const state = committed;
		return {
			ok: true,
			changed: JSON.stringify({ ...before, revision: 0 }) !== JSON.stringify({ ...state, revision: 0 }),
			state,
		};
	}

	#validate(request: ModeRequest): string | undefined {
		if (request.mode === "goal") {
			const state = this.#session.getGoalModeState();
			if (request.action === "resume" && !state?.enabled && state?.goal.status !== "paused")
				return "No paused goal to resume.";
			if (request.action === "replace" && !state?.enabled) return "No active goal to replace.";
			if (request.action === "budget" && !state) return "No current goal to budget.";
			if (request.action === "enter" && state?.goal.status === "paused")
				return "Resume or drop the paused goal before entering a new objective.";
			if (
				(request.action === "enter" || request.action === "replace") &&
				(typeof request.objective !== "string" || !request.objective.trim())
			)
				return "A non-empty objective is required.";
			if (
				"tokenBudget" in request &&
				request.tokenBudget != null &&
				(!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0)
			)
				return "tokenBudget must be a positive safe integer, or null to clear a budget.";
		}
		if (request.mode === "plan") {
			const active = this.#session.getPlanModeState()?.enabled === true;
			// TUI parity: pause needs an active (or already paused, idempotent)
			// plan, resume needs the paused state. Without this, `pause` from
			// inactive journals a synthetic plan_paused and `resume`/`enter`
			// semantics diverge from the interactive host.
			if (request.action === "pause" && !active && !this.#planPaused) return "No active plan to pause.";
			if (request.action === "resume" && !this.#planPaused) return "Plan mode is not paused.";
			if (
				"workflow" in request &&
				request.workflow !== undefined &&
				request.workflow !== "parallel" &&
				request.workflow !== "iterative"
			)
				return "workflow must be parallel or iterative.";
		}
		return undefined;
	}

	async #apply(request: ModeRequest): Promise<void> {
		switch (request.mode) {
			case "plan":
				if (request.action === "enter" && this.#planPaused) break;
				if (request.action === "enter" || request.action === "resume") await this.#enterPlan(request.workflow);
				else await this.#exitPlan(request.action === "pause");
				break;
			case "vibe":
				if (request.action === "enter") await this.#enterVibe();
				else await this.#exitVibe();
				break;
			case "goal":
				if (this.#host.goal) await this.#host.goal(request);
				else await this.#applyGoal(request);
				break;
			case "loop":
				throw new Error("Loop requires an interactive continuation driver.");
		}
	}

	async #enterPlan(workflow?: "parallel" | "iterative", restored = false): Promise<void> {
		if (this.#session.getPlanModeState()?.enabled) return;
		const session = this.#session;
		const previous = {
			tools: session.getEnabledToolNames(),
			mounted: session.getMountedXdevToolNames(),
			model: session.model,
			thinking: session.configuredThinkingLevel(),
		};
		const oldState = session.getPlanModeState();
		const planFilePath = this.#planDraft ?? oldState?.planFilePath ?? "local://PLAN.md";
		const planWorkflow = workflow ?? this.#planWorkflow ?? oldState?.workflow ?? "parallel";
		session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: planWorkflow,
			reentry: this.#planDraft !== undefined,
		});
		try {
			// Filter `write` out of the prior set and re-add it only when the live
			// entry is the built-in tool: a shadowing extension `write` has no
			// `xd://` proposal transport and would bypass plan read-only (TUI parity).
			await session.setActiveToolPresentation(
				[
					...new Set([
						...previous.tools.filter(name => name !== "write"),
						...(session.hasBuiltInTool("write") ? ["write"] : []),
					]),
				],
				previous.mounted,
			);
			if (!restored && this.#host.usePlanRole !== false) {
				const role = session.resolveRoleModelWithThinking("plan");
				if (role.model) await session.setModelTemporary(role.model, role.thinkingLevel);
			}
		} catch (error) {
			session.setPlanModeState(oldState);
			await session.setActiveToolPresentation(previous.tools, previous.mounted);
			if (previous.model) await session.setModelTemporary(previous.model, previous.thinking);
			throw error;
		}
		this.#planPrevious = previous;
		this.#planPaused = false;
		this.#planDraft = planFilePath;
		this.#planWorkflow = planWorkflow;
		session.setPlanProposalHandler(async title => {
			const result = await session.preparePlanForReview(title);
			// Headless hosts have no built-in review; never imply that the proposal was approved.
			return {
				...result,
				content: [
					{
						type: "text",
						text: planProposalHeadlessPrompt.trimEnd(),
					},
				],
			};
		});
		this.#host.onPlanEntered?.();
		if (!restored)
			session.sessionManager.appendModeChange("plan", {
				planFilePath,
				workflow: planWorkflow,
				previousTools: previous.tools,
				previousMountedTools: previous.mounted,
				previousModel: previous.model ? formatModelString(previous.model) : undefined,
				previousThinking: previous.thinking,
			});
	}

	async #exitPlan(paused: boolean, options?: { persist?: boolean; restoreModel?: boolean }): Promise<void> {
		const session = this.#session;
		if (!session.getPlanModeState()?.enabled && this.#planPaused === paused) return;
		const state = session.getPlanModeState();
		const tools = session.getEnabledToolNames();
		const mounted = session.getMountedXdevToolNames();
		const model = session.model;
		const thinking = session.configuredThinkingLevel();
		session.setPlanModeState(undefined);
		try {
			if (this.#planPrevious) {
				await session.restoreNonMCPToolPresentation(this.#planPrevious.tools, this.#planPrevious.mounted);
				// Session-change teardown passes restoreModel:false: the destination
				// journal ends on the plan-role change, and writing the pre-plan model
				// here would corrupt the recorded active model for a later restore.
				if (options?.restoreModel !== false) {
					if (this.#planPrevious.model && !modelsAreEqual(session.model, this.#planPrevious.model)) {
						await session.setModelTemporary(this.#planPrevious.model, this.#planPrevious.thinking);
					} else session.setThinkingLevel(this.#planPrevious.thinking);
				}
			}
		} catch (error) {
			session.setPlanModeState(state);
			await session.setActiveToolPresentation(tools, mounted);
			if (model) await session.setModelTemporary(model, thinking);
			throw error;
		}
		session.setPlanProposalHandler(null);
		this.#planPrevious = undefined;
		this.#planPaused = paused;
		if (options?.persist !== false)
			session.sessionManager.appendModeChange(
				paused ? "plan_paused" : "none",
				paused ? { planFilePath: this.#planDraft, workflow: this.#planWorkflow } : undefined,
			);
	}

	/** The host's approved proposal already owns the turn; this is not an extension approval API. */
	async completePlan(): Promise<void> {
		await this.#exitPlan(false);
		this.#publish();
	}

	#vibeParent(): VibeParentSession {
		const session = this.#session;
		return {
			getAgentId: () => session.getAgentId() ?? null,
			getSessionId: () => session.sessionManager.getSessionId(),
			getSessionFile: () => session.sessionFile ?? null,
			sessionManager: session.sessionManager,
			asyncJobManager: session.asyncJobManager,
			settings: session.settings,
			getActiveModelString: () => (session.model ? formatModelString(session.model) : undefined),
		};
	}

	async #enterVibe(restored = false): Promise<void> {
		if (this.#session.getVibeModeState()?.enabled) return;
		const previous = this.#session.getEnabledToolNames();
		const registry = VibeSessionRegistry.global();
		const scope = registry.ownerScope(this.#vibeParent());
		registry.activateScope(scope);
		try {
			await this.#session.activateVibeTools(this.#session.hasBuiltInTool("todo") ? ["read", "todo"] : ["read"]);
		} catch (error) {
			await registry.killAll(this.#vibeParent(), scope);
			throw error;
		}
		this.#vibePrevious = previous;
		this.#vibeScope = scope;
		this.#session.setVibeModeState({ enabled: true });
		if (!restored) this.#session.sessionManager.appendModeChange("vibe", { previousTools: previous });
	}

	async #exitVibe(persist = true): Promise<void> {
		if (!this.#session.getVibeModeState()?.enabled && !this.#vibeScope) return;
		await this.#session.runModeExitTeardown(async () => {
			await VibeSessionRegistry.global().killAll(this.#vibeParent(), this.#vibeScope);
			await this.#session.deactivateVibeTools(this.#vibePrevious ?? []);
			this.#session.setVibeModeState(undefined);
		});
		this.#vibeScope = undefined;
		this.#vibePrevious = undefined;
		// A journaled "vibe" survives reload/switch reconciliation; an explicit exit
		// must be recorded or a later restore re-enters vibe and resurrects the
		// worker tools. Dispose skips the write so quit preserves the mode like plan.
		if (persist) this.#session.sessionManager.appendModeChange("none");
	}

	async #applyGoal(request: Extract<ModeRequest, { mode: "goal" }>): Promise<void> {
		const session = this.#session;
		const state = session.getGoalModeState();
		const runtime = session.goalRuntime;
		switch (request.action) {
			case "enter":
				if (state?.enabled) return;
				if (state?.goal.status === "paused")
					throw new Error("Resume or drop the paused goal before entering a new objective.");
				await this.#enterGoal(() =>
					runtime.createGoal({ objective: request.objective, tokenBudget: request.tokenBudget }),
				);
				break;
			case "replace":
				if (state?.goal.objective === request.objective.trim() && state.goal.tokenBudget === request.tokenBudget)
					return;
				await runtime.replaceGoal({ objective: request.objective, tokenBudget: request.tokenBudget });
				break;
			case "resume":
				if (state?.enabled) return;
				if (state?.goal.status !== "paused") throw new Error("No paused goal to resume.");
				await this.#enterGoal(() => runtime.resumeGoal());
				break;
			case "pause":
			case "exit":
				if (!state?.enabled) return;
				await runtime.pauseGoal();
				await this.#restoreGoalTools();
				break;
			case "drop":
				if (!state) return;
				await this.#restoreGoalTools();
				await runtime.dropGoal();
				break;
			case "budget":
				if (!state || state.goal.status === "complete" || state.goal.status === "dropped")
					throw new Error("No current goal to budget.");
				if (state.goal.tokenBudget === (request.tokenBudget ?? undefined)) return;
				await runtime.onBudgetMutated(request.tokenBudget ?? undefined);
		}
	}

	async #enterGoal(start: () => Promise<unknown>): Promise<void> {
		const previous = this.#goalPrevious ?? this.#session.getEnabledToolNames();
		await this.#session.setActiveToolsByName([...new Set([...previous, "goal"])]);
		try {
			await start();
		} catch (error) {
			await this.#session.setActiveToolsByName(previous);
			throw error;
		}
		this.#goalPrevious = previous;
	}

	async #restoreGoalTools(): Promise<void> {
		if (this.#goalPrevious) await this.#session.setActiveToolsByName(this.#goalPrevious);
		this.#goalPrevious = undefined;
	}

	async #settleGoal(): Promise<void> {
		await this.#host.settled?.();
		const state = this.#session.getGoalModeState();
		if (!state?.enabled) await this.#restoreGoalTools();
		if (!this.#host.goal && state?.mode === "exiting") {
			this.#session.setGoalModeState(undefined);
			this.#session.sessionManager.appendModeChange("none");
		}
		this.#publish();
	}

	#publish(): ModeSnapshot {
		const current = this.getState();
		if (JSON.stringify({ ...this.#last, revision: 0 }) === JSON.stringify({ ...current, revision: 0 }))
			return current;
		const previous = this.#last;
		this.#revision++;
		const state = this.getState();
		this.#last = state;
		void Promise.resolve()
			.then(() =>
				this.#session.extensionRunner?.emit({
					type: "mode_changed",
					previous: structuredClone(previous),
					state: structuredClone(state),
				}),
			)
			.catch(error => logger.warn("Mode event notification failed", { error: String(error) }));
		void Promise.resolve()
			.then(() => this.#host.onChanged?.(structuredClone(state)))
			.catch(error => logger.warn("Mode host notification failed", { error: String(error) }));
		return structuredClone(state);
	}

	/** Refuse before the session transition mutates anything; teardown itself runs after the commit point. */
	assertCanChangeSession(): void {
		if (this.#transitioning)
			throw new Error("A mode transition is in progress; retry the session change after it settles.");
	}

	async beforeSessionChange(): Promise<void> {
		if (this.#vibeScope) {
			await VibeSessionRegistry.global().suspendScope(this.#vibeScope, this.#session.asyncJobManager);
			await this.#session.deactivateVibeTools(this.#vibePrevious ?? []);
			this.#session.setVibeModeState(undefined);
			this.#vibeScope = undefined;
			this.#vibePrevious = undefined;
		}
		// Stash the pre-plan model before #exitPlan clears it: a destination whose
		// journal records no model (`/new` boundary) would otherwise inherit the
		// live plan-role model. #restoreSession applies it only in that case —
		// TUI parity with `restorePlanModel: models.length === 0`.
		this.#planPreviousOnSwitch = this.#planPrevious;
		await this.#exitPlan(false, { persist: false, restoreModel: false });
		await this.#restoreGoalTools();
		this.#session.setGoalModeState(undefined);
		this.#session.goalRuntime.clearAccounting();
		this.#planDraft = undefined;
		this.#planWorkflow = undefined;
	}

	async reconcile(options?: { preserveActiveGoal?: boolean }): Promise<void> {
		if (this.#transitioning)
			throw new Error("A mode transition is in progress; retry reconciliation after it settles.");
		this.#transitioning = true;
		try {
			await this.#restoreSession(options);
		} finally {
			this.#transitioning = false;
			this.#publish();
		}
	}

	async #restoreSession(options?: { preserveActiveGoal?: boolean }): Promise<void> {
		const context = this.#session.sessionManager.buildSessionContext();
		this.#planPaused = context.mode === "plan_paused";
		this.#planDraft = typeof context.modeData?.planFilePath === "string" ? context.modeData.planFilePath : undefined;
		const workflow = context.modeData?.workflow;
		this.#planWorkflow = workflow === "parallel" || workflow === "iterative" ? workflow : undefined;
		if (context.mode === "plan" && cfgPlanEnabled.get(this.#session.settings)) {
			const restoredWorkflow = context.modeData?.workflow;
			await this.#enterPlan(
				restoredWorkflow === "parallel" || restoredWorkflow === "iterative" ? restoredWorkflow : undefined,
				true,
			);
			const data = context.modeData;
			if (this.#planPrevious && data) {
				if (Array.isArray(data.previousTools))
					this.#planPrevious.tools = data.previousTools.filter((name): name is string => typeof name === "string");
				if (Array.isArray(data.previousMountedTools))
					this.#planPrevious.mounted = data.previousMountedTools.filter(
						(name): name is string => typeof name === "string",
					);
				if (typeof data.previousModel === "string") {
					this.#planPrevious.model = this.#session
						.getAvailableModels()
						.find(model => formatModelString(model) === data.previousModel);
				}
				const thinking = data.previousThinking;
				if (typeof thinking === "string") this.#planPrevious.thinking = thinking as ConfiguredThinkingLevel;
			}
		} else if (context.mode === "vibe") {
			await VibeSessionRegistry.global().rehydrate(this.#vibeParent());
			await this.#enterVibe(true);
			if (Array.isArray(context.modeData?.previousTools))
				this.#vibePrevious = context.modeData.previousTools.filter(
					(name): name is string => typeof name === "string",
				);
		} else if ((context.mode === "goal" || context.mode === "goal_paused") && !this.#host.goal) {
			const goal = goalFromModeData(context.modeData);
			if (goal && cfgGoalEnabled.get(this.#session.settings)) {
				this.#session.setGoalModeState({ enabled: context.mode === "goal", mode: "active", goal });
				const previous = this.#session.getEnabledToolNames().filter(name => name !== "goal");
				await this.#session.setActiveToolsByName([...previous, "goal"]);
				this.#goalPrevious = previous;
				await this.#session.goalRuntime.onThreadResumed(options);
			}
		}

		// Model-less destination (new session, or a branch point before any
		// model_change): restore the pre-plan model so the fresh session does
		// not keep the plan-role selection. Journals into the destination.
		if (
			this.#planPreviousOnSwitch &&
			Object.keys(context.models).length === 0 &&
			!this.#session.getPlanModeState()?.enabled
		) {
			const stashed = this.#planPreviousOnSwitch;
			if (stashed.model) await this.#session.setModelTemporary(stashed.model, stashed.thinking);
			else this.#session.setThinkingLevel(stashed.thinking);
		}
		this.#planPreviousOnSwitch = undefined;
		await this.#host.reconcile?.(options);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#unsubscribe();
		await this.#exitVibe(false);
		await this.#restoreGoalTools();
		this.#planPreviousOnSwitch = undefined;
		this.#disposed = true;
	}
}
