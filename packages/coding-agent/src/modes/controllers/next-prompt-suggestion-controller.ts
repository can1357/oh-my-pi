import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import {
	generateNextPromptSuggestion,
	hasNextPromptSuggestionContext,
	NEXT_PROMPT_EXPIRY_MS,
	NEXT_PROMPT_TIMEOUT_MS,
	type NextPromptSuggestionGenerator,
} from "../next-prompt-suggestion";
import type { InteractiveModeContext } from "../types";
import { cfgNextPromptSuggestionEnabled } from "../settings";

function isEligible(
	ctx: InteractiveModeContext,
	event: Extract<AgentSessionEvent, { type: "agent_end" }>,
	session: AgentSession,
	editor: InteractiveModeContext["editor"],
): boolean {
	return (
		cfgNextPromptSuggestionEnabled.get(ctx.settings) &&
		event.isTerminal === true &&
		ctx.session === session &&
		ctx.viewSession === session &&
		ctx.focusedAgentId === undefined &&
		ctx.editor === editor &&
		ctx.ui.getFocused() === editor &&
		editor.getText() === "" &&
		!editor.isShowingAutocomplete() &&
		editor.pendingImages.length === 0 &&
		editor.pendingImageLinks.length === 0 &&
		session.isStreaming === false &&
		session.isCompacting === false &&
		session.hasDeferredPostPromptWork === false &&
		session.isGeneratingHandoff === false &&
		session.queuedMessageCount === 0 &&
		ctx.retryLoader === undefined &&
		ctx.planModeEnabled === false &&
		ctx.goalModeEnabled === false &&
		ctx.loopModeEnabled === false &&
		hasNextPromptSuggestionContext(event)
	);
}

export class NextPromptSuggestionController {
	readonly #ctx: InteractiveModeContext;
	readonly #generate: NextPromptSuggestionGenerator;
	#generation = 0;
	#abortController: AbortController | undefined;
	#activeEditor: InteractiveModeContext["editor"] | undefined;
	#expiryTimer: Timer | undefined;
	#timeoutTimer: Timer | undefined;
	#disposed = false;

	constructor(ctx: InteractiveModeContext, generate: NextPromptSuggestionGenerator = generateNextPromptSuggestion) {
		this.#ctx = ctx;
		this.#generate = generate;
	}

	get revision(): number {
		return this.#generation;
	}

	request(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		if (this.#disposed) return;
		this.#invalidateActive();
		const generation = this.#generation;
		const session = this.#ctx.session;
		const editor = this.#ctx.editor;
		if (!isEligible(this.#ctx, event, session, editor)) return;
		const abortController = new AbortController();
		this.#abortController = abortController;
		this.#activeEditor = editor;
		this.#timeoutTimer = setTimeout(() => {
			if (!this.#ownsRequest(generation, abortController)) return;
			this.#timeoutTimer = undefined;
			this.#invalidateActive();
		}, NEXT_PROMPT_TIMEOUT_MS);

		let request: Promise<string | null>;
		try {
			request = this.#generate({
				session,
				settings: this.#ctx.settings,
				event,
				signal: abortController.signal,
			});
		} catch {
			if (this.#ownsRequest(generation, abortController)) this.#invalidateActive();
			return;
		}
		void request
			.then(suggestion => {
				if (!this.#ownsRequest(generation, abortController)) {
					this.#requestLateDiscardRepaint(editor);
					return;
				}
				this.#clearTimeoutTimer();
				if (!suggestion) {
					this.#abortController = undefined;
					this.#activeEditor = undefined;
					return;
				}
				if (!isEligible(this.#ctx, event, session, editor)) {
					this.#invalidateActive();
					return;
				}
				this.#abortController = undefined;
				editor.setNextPromptSuggestion(suggestion);
				this.#ctx.ui.requestComponentRender(editor);
				this.#expiryTimer = setTimeout(() => {
					if (this.#disposed || this.#generation !== generation || this.#activeEditor !== editor) {
						return;
					}
					this.#expiryTimer = undefined;
					this.#invalidateActive();
				}, NEXT_PROMPT_EXPIRY_MS);
			})
			.catch(() => {
				if (this.#ownsRequest(generation, abortController)) {
					this.#invalidateActive();
				} else {
					this.#requestLateDiscardRepaint(editor);
				}
			});
	}

	invalidate(): void {
		if (this.#disposed) return;
		this.#invalidateActive();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#invalidateActive();
	}

	#invalidateActive(): void {
		this.#generation++;
		this.#clearTimeoutTimer();
		this.#clearExpiryTimer();
		this.#abortController?.abort();
		this.#abortController = undefined;
		const editor = this.#activeEditor ?? this.#ctx.editor;
		this.#activeEditor = undefined;
		editor.clearNextPromptSuggestion();
		this.#ctx.ui.requestComponentRender(editor);
	}

	#ownsRequest(generation: number, abortController: AbortController): boolean {
		return (
			!this.#disposed &&
			this.#generation === generation &&
			this.#abortController === abortController &&
			!abortController.signal.aborted
		);
	}

	#clearTimeoutTimer(): void {
		if (this.#timeoutTimer === undefined) return;
		clearTimeout(this.#timeoutTimer);
		this.#timeoutTimer = undefined;
	}

	#clearExpiryTimer(): void {
		if (this.#expiryTimer === undefined) return;
		clearTimeout(this.#expiryTimer);
		this.#expiryTimer = undefined;
	}

	#requestLateDiscardRepaint(editor: InteractiveModeContext["editor"]): void {
		if (!this.#disposed) this.#ctx.ui.requestComponentRender(editor);
	}
}
