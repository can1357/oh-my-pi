import type { Model } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import type { ExtensionAPI, ExtensionContext } from "../extensibility/extensions/types";
import type { ThinkingLevelChangeEntry } from "../session/session-entries";
import codeModelReviewPrompt from "../prompts/system/code-model-review.md" with { type: "text" };
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import { availableCodeModels, resolveCodeModelSelection } from "./model-menu";

export const CODE_MODEL_STATE_TYPE = "code-model-phase-v1";
export const CODE_MODEL_REVIEW_PROMPT = codeModelReviewPrompt.trim();

interface ModelState {
	provider: string;
	id: string;
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

function sameModel(model: Model | undefined, state: ModelState): boolean {
	return model?.provider === state.provider && model.id === state.id;
}

function describeModelState(state: ModelState): string {
	return `${state.provider}/${state.id} · ${state.effort ?? "default"}`;
}

function isModelState(value: unknown): value is ModelState {
	if (!value || typeof value !== "object") return false;
	const effort = "effort" in value ? value.effort : undefined;
	return (
		"provider" in value &&
		typeof value.provider === "string" &&
		"id" in value &&
		typeof value.id === "string" &&
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

export function installCodeModelSession(pi: ExtensionAPI, settings: Settings): CodeModelSessionController {
	let state: PhaseState | undefined;
	let busy = false;

	const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const branch = (ctx: ExtensionContext) => ctx.sessionManager.getBranch();

	function configuredThinkingLevel(ctx: ExtensionContext): ConfiguredThinkingLevel | undefined {
		const entry = branch(ctx).findLast(item => item.type === "thinking_level_change") as
			| ThinkingLevelChangeEntry
			| undefined;
		const configured = entry?.configured ?? entry?.thinkingLevel;
		return parseConfiguredThinkingLevel(configured) ?? pi.getThinkingLevel();
	}

	function snapshot(ctx: ExtensionContext): ModelState {
		const model = ctx.models.current();
		if (!model) throw new Error("The current session requires a valid model.");
		return { provider: model.provider, id: model.id, effort: configuredThinkingLevel(ctx) };
	}

	function currentMatches(ctx: ExtensionContext, target: ModelState): boolean {
		return sameModel(ctx.models.current(), target) && configuredThinkingLevel(ctx) === target.effort;
	}

	function save(next: PhaseState | undefined): void {
		pi.appendEntry(CODE_MODEL_STATE_TYPE, next);
		state = next;
	}

	async function guarded<T>(operation: () => Promise<T>): Promise<T> {
		if (busy) throw new Error("A code-model phase switch is already in progress.");
		busy = true;
		try {
			return await operation();
		} finally {
			busy = false;
		}
	}

	async function apply(ctx: ExtensionContext, target: ModelState): Promise<void> {
		const model = ctx.models
			.list()
			.find(candidate => candidate.provider === target.provider && candidate.id === target.id);
		if (!model) throw new Error(`The available model catalogue must contain ${target.provider}/${target.id}.`);
		if (!sameModel(ctx.models.current(), target) && !(await pi.setModel(model))) {
			throw new Error(`Check the existing authentication for ${target.provider}/${target.id}.`);
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
		if (
			!options.force &&
			!interrupted &&
			!currentMatches(ctx, previous.coding) &&
			!currentMatches(ctx, previous.original)
		) {
			save(undefined);
			return {
				changed: false,
				message: "Preserved the model and effort selected outside code-model and ended the coding phase.",
			};
		}
		save({ ...previous, phase: "restoring" });
		await apply(ctx, previous.original);
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
		const coding: ModelState = {
			provider: selection.model.provider,
			id: selection.model.id,
			effort: selection.effort,
		};
		const id = sessionId(ctx);
		signal?.throwIfAborted();
		save({ version: 1, sessionId: id, phase: "switching", original, coding });
		try {
			await apply(ctx, coding);
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
			ctx.ui.notify(result.message, "info");
			return {
				...result,
				message: result.changed ? `${result.message} ${CODE_MODEL_REVIEW_PROMPT}` : result.message,
			};
		});
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
	pi.on("session_before_switch", () => (busy ? { cancel: true } : undefined));
	pi.on("session_before_tree", () => (busy ? { cancel: true } : undefined));
	pi.on("session_before_branch", () => (busy ? { cancel: true } : undefined));
	pi.on("session_stop", async (event, ctx) => {
		if (!state || busy || event.signal.aborted) return;
		const result = await guarded(() => restore(ctx));
		ctx.ui.notify(result.message, "info");
		const last = event.last_assistant_message ?? event.messages.findLast(message => message.role === "assistant");
		if (result.changed && last?.role === "assistant" && last.stopReason === "stop" && !event.signal.aborted) {
			return { continue: true, additionalContext: CODE_MODEL_REVIEW_PROMPT };
		}
	});
	pi.on("agent_end", async (event, ctx) => {
		if (!state || busy || event.willContinue) return;
		try {
			const result = await guarded(() => restore(ctx));
			ctx.ui.notify(result.message, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Coding phase recovery failed: ${message} Run /code-model finish to retry.`, "error");
		}
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
