/**
 * Prompts an extension may answer on the user's behalf: tool approvals and `ask` forms that are
 * open right now. One instance per extension runner (one session). Each prompt is answered once:
 * the first of the host's dialog and `ctx.resolve*` to settle it wins, and the other is turned away.
 */
import { acceptedApprovalAnswer } from "../../tools/approval";
import type {
	AskRequestedEvent,
	AskResolvedEvent,
	ExtensionApprovalAnswer,
	ExtensionAskAnswer,
	ExtensionAskData,
	ToolApprovalRequestedEvent,
} from "./types";

/** A pending prompt as its owner sees it: the extension's answer, if one arrives, and the way to close it. */
export interface PendingPrompt<TAnswer> {
	/** Settles with the extension's answer; never rejects, and stays pending when the owner closes first. */
	readonly answer: Promise<TAnswer>;
	/** The extension's answer once given, synchronously; `undefined` while none. */
	given(): TAnswer | undefined;
	/** The prompt was answered elsewhere or abandoned: extensions can no longer answer it. Idempotent. */
	close(): void;
}

interface Entry<TEvent, TAnswer> {
	event: TEvent;
	/** Normalizes an extension's answer, or rejects it with `undefined`. */
	accept(answer: TAnswer): TAnswer | undefined;
	settle(answer: TAnswer): void;
	given?: TAnswer;
}

class PromptTable<TEvent, TAnswer> {
	readonly #entries = new Map<string, Entry<TEvent, TAnswer>>();

	open(id: string, event: TEvent, accept: (answer: TAnswer) => TAnswer | undefined): PendingPrompt<TAnswer> {
		const { promise, resolve } = Promise.withResolvers<TAnswer>();
		const entry: Entry<TEvent, TAnswer> = { event, accept, settle: resolve };
		this.#entries.set(id, entry);
		return {
			answer: promise,
			given: () => entry.given,
			close: () => {
				if (this.#entries.get(id) === entry) this.#entries.delete(id);
			},
		};
	}

	resolve(id: string, answer: TAnswer): boolean {
		const entry = this.#entries.get(id);
		if (!entry) return false;
		const accepted = entry.accept(answer);
		if (accepted === undefined) return false;
		this.#entries.delete(id);
		entry.given = accepted;
		entry.settle(accepted);
		return true;
	}

	list(): TEvent[] {
		return [...this.#entries.values()].map(entry => structuredClone(entry.event));
	}
}

/**
 * How the `ask` tool offers its form to extensions: open it as pending (after `ask_requested`
 * handlers ran, so one may already have answered), then report how it closed.
 */
export interface ExtensionAskChannel {
	open(
		event: AskRequestedEvent,
		accept: (data: ExtensionAskData) => ExtensionAskData | undefined,
	): Promise<PendingPrompt<ExtensionAskAnswer>>;
	resolved(event: AskResolvedEvent): Promise<void>;
}

export class PendingInteractions {
	readonly #approvals = new PromptTable<ToolApprovalRequestedEvent, ExtensionApprovalAnswer>();
	readonly #asks = new PromptTable<AskRequestedEvent, ExtensionAskAnswer>();

	openApproval(event: ToolApprovalRequestedEvent): PendingPrompt<ExtensionApprovalAnswer> {
		return this.#approvals.open(event.toolCallId, event, answer => acceptedApprovalAnswer(event.prompt, answer));
	}

	resolveApproval(toolCallId: string, answer: ExtensionApprovalAnswer): boolean {
		return this.#approvals.resolve(toolCallId, answer);
	}

	pendingApprovals(): ToolApprovalRequestedEvent[] {
		return this.#approvals.list();
	}

	/** `accept` turns a data answer into the form's submitted data, or rejects it; `cancel` is always accepted. */
	openAsk(
		event: AskRequestedEvent,
		accept: (data: ExtensionAskData) => ExtensionAskData | undefined,
	): PendingPrompt<ExtensionAskAnswer> {
		return this.#asks.open(event.askId, event, answer => {
			if (answer === "cancel") return answer;
			if (typeof answer !== "object" || answer === null || typeof answer.data !== "object" || answer.data === null) {
				return undefined;
			}
			const data = accept(structuredClone(answer.data));
			return data ? { data } : undefined;
		});
	}

	resolveAsk(askId: string, answer: ExtensionAskAnswer): boolean {
		return this.#asks.resolve(askId, answer);
	}

	pendingAsks(): AskRequestedEvent[] {
		return this.#asks.list();
	}
}
