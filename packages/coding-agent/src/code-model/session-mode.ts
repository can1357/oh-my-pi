import type { Model } from "@oh-my-pi/pi-ai";
import { formatModelStringWithRouting, parsePersistedModelSelector } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeIdleEvent,
	SessionStopEventResult,
} from "../extensibility/extensions/types";
import { EPHEMERAL_MODEL_CHANGE_ROLE, type ModelChangeEntry } from "../session/session-entries";
import codeModelReviewPrompt from "../prompts/system/code-model-review.md" with { type: "text" };
import { parseConfiguredThinkingLevel, type ConfiguredThinkingLevel } from "../thinking";
import { availableCodeModels, resolveCodeModelSelection } from "./model-menu";

export const CODE_MODEL_STATE_TYPE = "code-model-phase-v1";
export const CODE_MODEL_REVIEW_PROMPT = codeModelReviewPrompt.trim();

interface ModelState {
	provider: string;
	id: string;
	selector?: string;
	role?: string;
	effort?: ConfiguredThinkingLevel;
}

interface PhaseState {
	version: 1;
	sessionId: string;
	phase: "switching" | "coding" | "restoring";
	original: ModelState;
	coding: ModelState;
}

export interface CodeModelResult {
	changed: boolean;
	message: string;
	phase?: PhaseState["phase"];
}

export interface CodeModelSessionController {
	run(action: "start" | "finish" | "status", ctx: ExtensionContext, signal?: AbortSignal): Promise<CodeModelResult>;
}

export type CodeModelBeforeIdleHandler = (
	event: SessionBeforeIdleEvent,
	ctx: ExtensionContext,
) => Promise<SessionStopEventResult | undefined>;

export type CodeModelBeforeNavigationHandler = (ctx: ExtensionContext) => Promise<{ cancel?: boolean } | undefined>;

export interface CodeModelSessionHooks {
	getRetryFallbackPrimary?: () =>
		| {
				selector: string;
				effort: ConfiguredThinkingLevel | undefined;
				fallbackEffort?: ConfiguredThinkingLevel;
		  }
		| undefined;
	registerBeforeIdle?: (handler: CodeModelBeforeIdleHandler) => void;
	registerBeforeNavigation?: (handler: CodeModelBeforeNavigationHandler) => void;
}

function sameModel(model: Model | undefined, state: ModelState): boolean {
	if (!model) return false;
	if (state.selector) {
		return formatModelStringWithRouting(model) === state.selector;
	}
	return model.provider === state.provider && model.id === state.id;
}

function describeModelState(state: ModelState): string {
	const modelName = state.selector ?? `${state.provider}/${state.id}`;
	return `${modelName} · ${state.effort ?? "default"}`;
}

function isModelState(value: unknown): value is ModelState {
	if (!value || typeof value !== "object") return false;
	const effort = "effort" in value ? value.effort : undefined;
	const selector = "selector" in value ? value.selector : undefined;
	const role = "role" in value ? value.role : undefined;
	return (
		"provider" in value &&
		typeof value.provider === "string" &&
		"id" in value &&
		typeof value.id === "string" &&
		(selector === undefined || typeof selector === "string") &&
		(role === undefined || typeof role === "string") &&
		(effort === undefined || parseConfiguredThinkingLevel(typeof effort === "string" ? effort : undefined) === effort)
	);
}

function isPhaseState(value: unknown): value is PhaseState {
	return (
		!!value &&
		typeof value === "object" &&
		"version" in value &&
		value.version === 1 &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		"phase" in value &&
		(value.phase === "switching" || value.phase === "coding" || value.phase === "restoring") &&
		"original" in value &&
		isModelState(value.original) &&
		"coding" in value &&
		isModelState(value.coding)
	);
}

export function installCodeModelSession(
	pi: ExtensionAPI,
	settings: Settings,
	hooks: CodeModelSessionHooks = {},
): CodeModelSessionController {
	let state: PhaseState | undefined;
	let busy = false;
	let inFlight: Promise<unknown> | undefined;
	let reviewPending = false;
	const usesInternalFinalizer = hooks.registerBeforeIdle !== undefined;

	const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const branch = (ctx: ExtensionContext) => ctx.sessionManager.getBranch();

	function configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return pi.getConfiguredThinkingLevel();
	}

	function getActiveRole(ctx: ExtensionContext, selector: string): string {
		const entries = branch(ctx);
		const entry = entries.findLast(
			item => item.type === "model_change" && item.model === selector && !item.resolvedModelIsFallback,
		) as ModelChangeEntry | undefined;
		return entry
			? (entry.role ?? "default")
			: entries.some(item => item.type === "model_change")
				? "temporary"
				: "default";
	}

	function snapshot(ctx: ExtensionContext): ModelState {
		const fallbackPrimary = hooks.getRetryFallbackPrimary?.();
		const model = fallbackPrimary
			? parsePersistedModelSelector(fallbackPrimary.selector, ctx.models.list()).model
			: ctx.models.current();
		if (!model) {
			const identifier = fallbackPrimary?.selector ?? "the current session model";
			throw new Error(`The available model catalogue must contain ${identifier}.`);
		}
		const selector = formatModelStringWithRouting(model);
		return {
			provider: model.provider,
			id: model.id,
			selector,
			role: getActiveRole(ctx, selector),
			effort: fallbackPrimary ? fallbackPrimary.effort : configuredThinkingLevel(),
		};
	}

	function currentMatches(ctx: ExtensionContext, target: ModelState): boolean {
		return sameModel(ctx.models.current(), target) && configuredThinkingLevel() === target.effort;
	}
	function retryFallbackIsActive(ctx: ExtensionContext): boolean {
		const latest = branch(ctx).findLast(item => item.type === "model_change") as ModelChangeEntry | undefined;
		return latest?.resolvedModelIsFallback === true;
	}

	function save(next: PhaseState | undefined): void {
		pi.appendEntry(CODE_MODEL_STATE_TYPE, next);
		state = next;
	}

	async function guarded<T>(operation: () => Promise<T>): Promise<T> {
		if (busy) throw new Error("A code-model phase switch is already in progress.");
		busy = true;
		const pending = operation();
		inFlight = pending;
		try {
			return await pending;
		} finally {
			if (inFlight === pending) inFlight = undefined;
			busy = false;
		}
	}

	async function apply(
		ctx: ExtensionContext,
		target: ModelState,
		options: { ephemeral?: boolean; role?: string } = {},
	): Promise<void> {
		const model = target.selector
			? ctx.models.resolve(target.selector)
			: ctx.models.list().find(candidate => candidate.provider === target.provider && candidate.id === target.id);
		const identifier = target.selector ?? `${target.provider}/${target.id}`;
		if (!model || !sameModel(model, target)) {
			throw new Error(`The available model catalogue must contain ${identifier}.`);
		}
		const setModelOptions = options.ephemeral
			? { ephemeral: true }
			: { role: options.role ?? target.role ?? "default" };
		const latest = branch(ctx).findLast(item => item.type === "model_change") as ModelChangeEntry | undefined;
		const restoreRole =
			!options.ephemeral &&
			latest?.role === EPHEMERAL_MODEL_CHANGE_ROLE &&
			setModelOptions.role !== EPHEMERAL_MODEL_CHANGE_ROLE;
		const claimEphemeralRole = options.ephemeral && latest?.role !== EPHEMERAL_MODEL_CHANGE_ROLE;
		if (
			(!sameModel(ctx.models.current(), target) || restoreRole || claimEphemeralRole) &&
			!(await pi.setModel(model, setModelOptions))
		) {
			throw new Error(`Check the existing authentication for ${identifier}.`);
		}
		pi.setThinkingLevel(target.effort);
		if (!currentMatches(ctx, target)) {
			throw new Error(`The session did not reach the requested model state: ${describeModelState(target)}.`);
		}
	}

	async function restore(ctx: ExtensionContext, options: { force?: boolean } = {}): Promise<CodeModelResult> {
		if (!state || state.sessionId !== sessionId(ctx)) {
			return { changed: false, message: "Main conversation phase is active." };
		}
		const previous = state;
		const active = ctx.models.current();
		const interrupted =
			previous.phase !== "coding" && (sameModel(active, previous.original) || sameModel(active, previous.coding));
		const effort = configuredThinkingLevel();
		const retryFallback = hooks.getRetryFallbackPrimary?.();
		const fallbackEffort =
			retryFallback && "fallbackEffort" in retryFallback ? retryFallback.fallbackEffort : previous.coding.effort;
		const latest = branch(ctx).findLast(item => item.type === "model_change") as ModelChangeEntry | undefined;
		// Legacy phase snapshots predate explicit role attribution.
		const codingRoleMatches = previous.original.role === undefined || latest?.role === EPHEMERAL_MODEL_CHANGE_ROLE;
		const codingStateMatches =
			(codingRoleMatches && sameModel(active, previous.coding) && effort === previous.coding.effort) ||
			(retryFallbackIsActive(ctx) && effort === fallbackEffort);
		if (!options.force && !interrupted && !codingStateMatches && !currentMatches(ctx, previous.original)) {
			save(undefined);
			return {
				changed: false,
				message: "Preserved the model and effort selected outside code-model and ended the coding phase.",
			};
		}
		save({ ...previous, phase: "restoring" });
		await apply(ctx, previous.original, { role: previous.original.role ?? "default" });
		save(undefined);
		return { changed: true, message: `Restored main conversation model: ${describeModelState(previous.original)}.` };
	}

	async function start(ctx: ExtensionContext, signal?: AbortSignal): Promise<CodeModelResult> {
		if (state?.sessionId === sessionId(ctx)) {
			if (state.phase !== "coding") {
				throw new Error("The previous model switch still needs restoration. Run code-model finish first.");
			}
			if (currentMatches(ctx, state.coding)) {
				return {
					changed: false,
					phase: state.phase,
					message: `Coding phase is active: ${describeModelState(state.coding)}. Call code-model finish alone after implementation and targeted checks.`,
				};
			}
			save(undefined);
		}

		signal?.throwIfAborted();
		const selection = resolveCodeModelSelection(settings, availableCodeModels(ctx));
		if (!selection) {
			throw new Error("Configure an authenticated text-and-tool-capable coding model with /code-model.");
		}
		const original = snapshot(ctx);
		const codingSelector = formatModelStringWithRouting(selection.model);
		const coding: ModelState = {
			provider: selection.model.provider,
			id: selection.model.id,
			selector: codingSelector,
			effort: selection.effort,
		};
		const id = sessionId(ctx);
		signal?.throwIfAborted();
		save({ version: 1, sessionId: id, phase: "switching", original, coding });
		try {
			await apply(ctx, coding, { ephemeral: true });
			signal?.throwIfAborted();
			if (sessionId(ctx) !== id) throw new Error("The session changed during the model switch.");
			if (!state) throw new Error("The coding phase state was cleared during the model switch.");
			save({ ...state, phase: "coding" });
		} catch (error) {
			if (sessionId(ctx) === id) {
				try {
					await restore(ctx, { force: true });
				} catch (recoveryError) {
					const primary = error instanceof Error ? error.message : String(error);
					const recovery = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
					throw new Error(`${primary} Original model restoration also failed: ${recovery}`);
				}
			}
			throw error;
		}
		ctx.ui.notify(
			`Coding phase: ${describeModelState(coding)}; completion restores ${describeModelState(original)}.`,
			"info",
		);
		return {
			changed: true,
			phase: "coding",
			message: `Entered coding phase in the same conversation: ${describeModelState(coding)}. Existing history, tools, and permissions remain active. Implement and run targeted checks, then call code-model finish alone for original-model review.`,
		};
	}

	async function run(
		action: "start" | "finish" | "status",
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<CodeModelResult> {
		if (action === "status") {
			const selection = resolveCodeModelSelection(settings, availableCodeModels(ctx));
			const configured = selection
				? describeModelState({
						provider: selection.model.provider,
						id: selection.model.id,
						selector: formatModelStringWithRouting(selection.model),
						effort: selection.effort,
					})
				: "unconfigured";
			return {
				changed: false,
				phase: state?.phase,
				message: `Coding model setting: ${configured}. ${
					state
						? `Current phase: ${state.phase}; restore target: ${describeModelState(state.original)}.`
						: "Main conversation phase is active."
				}`,
			};
		}
		return guarded(async () => {
			if (action === "start") return start(ctx, signal);
			const result = await restore(ctx);
			reviewPending = false;
			ctx.ui.notify(result.message, "info");
			return {
				...result,
				message: result.changed ? `${result.message} ${CODE_MODEL_REVIEW_PROMPT}` : result.message,
			};
		});
	}

	async function prepareNavigation(ctx: ExtensionContext) {
		if (busy) return { cancel: true as const };
		if (!state) {
			reviewPending = false;
			return undefined;
		}
		try {
			await guarded(() => restore(ctx));
			reviewPending = false;
			return undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Coding phase recovery failed: ${message} Resolve it before navigating the session.`, "error");
			return { cancel: true as const };
		}
	}

	async function recover(_event: unknown, ctx: ExtensionContext): Promise<void> {
		const entry = branch(ctx).findLast(item => item.type === "custom" && item.customType === CODE_MODEL_STATE_TYPE);
		const saved = entry?.type === "custom" ? entry.data : undefined;
		state = isPhaseState(saved) ? { ...saved, sessionId: sessionId(ctx) } : undefined;
		if (!state) return;
		try {
			const result = await guarded(() => restore(ctx));
			ctx.ui.notify(`Resuming session: ${result.message}`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Coding phase recovery failed: ${message} Run /code-model finish to retry.`, "error");
		}
	}

	pi.on("session_start", recover);
	pi.on("session_switch", recover);
	pi.on("session_tree", recover);
	pi.on("session_branch", recover);
	if (hooks.registerBeforeNavigation) {
		hooks.registerBeforeNavigation(prepareNavigation);
	} else {
		pi.on("session_before_switch", (_event, ctx) => prepareNavigation(ctx));
		pi.on("session_before_tree", (_event, ctx) => prepareNavigation(ctx));
		pi.on("session_before_branch", (_event, ctx) => prepareNavigation(ctx));
	}
	pi.on("session_stop", async (event, ctx) => {
		if (!state || busy || event.signal.aborted) return;
		const last = event.last_assistant_message ?? event.messages.findLast(message => message.role === "assistant");
		const shouldReview = last?.role === "assistant" && last.stopReason === "stop";
		if (usesInternalFinalizer && shouldReview) reviewPending = true;
		const result = await guarded(() => restore(ctx));
		ctx.ui.notify(result.message, "info");
		if (usesInternalFinalizer && (!result.changed || event.signal.aborted)) reviewPending = false;
		if (result.changed && shouldReview && !event.signal.aborted && !usesInternalFinalizer) {
			return { continue: true, additionalContext: CODE_MODEL_REVIEW_PROMPT };
		}
	});
	const beforeIdle: CodeModelBeforeIdleHandler = async (event, ctx) => {
		if (event.willContinue) return;
		if (inFlight) {
			try {
				await inFlight;
			} catch {
				// The restoration below retries from the persisted phase state.
			}
		}
		if (!state) {
			if (reviewPending) {
				reviewPending = false;
				return { continue: true, additionalContext: CODE_MODEL_REVIEW_PROMPT };
			}
			return;
		}
		try {
			const result = await guarded(() => restore(ctx));
			ctx.ui.notify(result.message, "info");
			if (reviewPending) {
				reviewPending = false;
				if (result.changed) {
					return { continue: true, additionalContext: CODE_MODEL_REVIEW_PROMPT };
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Coding phase recovery failed: ${message} Run /code-model finish to retry.`, "error");
		}
	};
	if (hooks.registerBeforeIdle) hooks.registerBeforeIdle(beforeIdle);
	else
		pi.on("session_before_idle", async (event, ctx) => {
			await beforeIdle(event, ctx);
		});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!state || busy) return;
		try {
			await guarded(() => restore(ctx));
		} catch {
			// Persisted phase state is restored when this session resumes.
		}
	});

	return { run };
}
