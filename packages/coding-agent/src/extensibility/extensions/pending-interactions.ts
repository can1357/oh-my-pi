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
	/** The private copy, without `signal`: answers are checked against it and listings clone it. */
	event: TEvent;
	/**
	 * The live signal listings hand back (it cannot be cloned): the emitted event's `signal`, else the one
	 * the prompt was opened with (the `ask` form is emitted without one and opened with the dialog's).
	 */
	listedSignal?: AbortSignal;
	/** Normalizes an extension's answer, or rejects it with `undefined`. */
	accept(answer: TAnswer): TAnswer | undefined;
	settle(answer: TAnswer): void;
	given?: TAnswer;
}

class PromptTable<TEvent extends { signal?: AbortSignal }, TAnswer> {
	readonly #entries = new Map<string, Entry<TEvent, TAnswer>>();

	/**
	 * `event` is the emitted one; the table keeps a private copy without its `signal`, and lists it with a
	 * live signal reattached (see `listedSignal`). `signal` aborting closes the prompt, so an extension
	 * answering after the call was aborted gets false.
	 */
	open(
		id: string,
		event: TEvent,
		accept: (copy: TEvent, answer: TAnswer) => TAnswer | undefined,
		signal?: AbortSignal,
	): PendingPrompt<TAnswer> {
		const { promise, resolve } = Promise.withResolvers<TAnswer>();
		const { signal: eventSignal, ...rest } = event;
		const copy = structuredClone(rest) as TEvent;
		const entry: Entry<TEvent, TAnswer> = {
			event: copy,
			listedSignal: eventSignal ?? signal,
			accept: answer => accept(copy, answer),
			settle: resolve,
		};
		const close = () => {
			signal?.removeEventListener("abort", close);
			if (this.#entries.get(id) === entry) this.#entries.delete(id);
		};
		if (!signal?.aborted) {
			this.#entries.set(id, entry);
			signal?.addEventListener("abort", close, { once: true });
		}
		return { answer: promise, given: () => entry.given, close };
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

	/** Clones of the pending events, each with its live `signal` so remote work can still be cancelled. */
	list(): TEvent[] {
		return [...this.#entries.values()].map(entry => {
			const listed = structuredClone(entry.event);
			if (entry.listedSignal) listed.signal = entry.listedSignal;
			return listed;
		});
	}
}

/**
 * How the `ask` tool offers its form to extensions: open it as pending (after `ask_requested`
 * handlers ran, so one may already have answered), then report how it closed.
 */
export interface ExtensionAskChannel {
	/** `signal` (the dialog's) closes the prompt and stops waiting on `ask_requested` handlers: it rejects with an abort. */
	open(
		event: AskRequestedEvent,
		accept: (data: ExtensionAskData) => ExtensionAskData | undefined,
		signal: AbortSignal,
	): Promise<PendingPrompt<ExtensionAskAnswer>>;
	resolved(event: AskResolvedEvent): Promise<void>;
}

export class PendingInteractions {
	readonly #approvals = new PromptTable<ToolApprovalRequestedEvent, ExtensionApprovalAnswer>();
	readonly #asks = new PromptTable<AskRequestedEvent, ExtensionAskAnswer>();

	openApproval(event: ToolApprovalRequestedEvent, signal?: AbortSignal): PendingPrompt<ExtensionApprovalAnswer> {
		// Answers are checked against the table's private copy: handlers may edit the emitted event.
		return this.#approvals.open(
			event.approvalId,
			event,
			(copy, answer) => acceptedApprovalAnswer(copy.prompt, answer),
			signal,
		);
	}

	resolveApproval(approvalId: string, answer: ExtensionApprovalAnswer): boolean {
		return this.#approvals.resolve(approvalId, answer);
	}

	pendingApprovals(): ToolApprovalRequestedEvent[] {
		return this.#approvals.list();
	}

	/** `accept` turns a data answer into the form's submitted data, or rejects it; `cancel` is always accepted. */
	openAsk(
		event: AskRequestedEvent,
		accept: (data: ExtensionAskData) => ExtensionAskData | undefined,
		signal?: AbortSignal,
	): PendingPrompt<ExtensionAskAnswer> {
		return this.#asks.open(
			event.askId,
			event,
			(_copy, answer) => {
				if (answer === "cancel") return answer;
				if (
					typeof answer !== "object" ||
					answer === null ||
					typeof answer.data !== "object" ||
					answer.data === null
				) {
					return undefined;
				}
				const data = accept(structuredClone(answer.data));
				return data ? { data } : undefined;
			},
			signal,
		);
	}

	resolveAsk(askId: string, answer: ExtensionAskAnswer): boolean {
		return this.#asks.resolve(askId, answer);
	}

	pendingAsks(): AskRequestedEvent[] {
		return this.#asks.list();
	}
}
