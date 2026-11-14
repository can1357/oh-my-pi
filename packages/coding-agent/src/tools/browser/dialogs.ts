import type { Dialog, Frame, Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Automatic JavaScript-dialog policy. */
export type DialogPolicy = "accept" | "dismiss";

/** JSON-safe description of the currently pending JavaScript dialog. */
export interface DialogState {
	/** Whether a confirm or prompt is waiting for a decision. */
	open: boolean;
	/** Browser dialog kind. */
	type?: string;
	/** Page-provided dialog message. */
	message?: string;
	/** Page-provided prompt default. */
	defaultValue?: string;
}

/**
 * The error of a page call that a pending confirm or prompt keeps from running: the page's script is stopped in the
 * dialog until it is answered. `when` says whether it was open before the call (`"is open"`) or opened during it.
 */
export function dialogBlocksPageError(label: string, state: DialogState, when: "is open" | "opened"): ToolError {
	const dialog = `${state.type ?? "JavaScript"}(${JSON.stringify(state.message?.slice(0, 80) ?? "")})`;
	return new ToolError(
		`${label}: a ${dialog} dialog ${when === "is open" ? "is open" : "opened while it ran"} and blocks the page until it is answered; call tab.handleDialog({ accept: true }) or tab.handleDialog({ accept: false }), or tab.setDialogs("accept" | "dismiss") to answer every dialog`,
	);
}

/** Runtime controller for automatic and explicitly handled JavaScript dialogs. */
export class RuntimeDialogController {
	readonly #page: Page;
	readonly #logFailure: (message: string, details: Record<string, unknown>) => void;
	#policy: DialogPolicy | undefined;
	#pending: Dialog | undefined;
	#installed = false;
	/** Callers of {@link whenPending} still waiting. */
	readonly #waiters = new Set<(state: DialogState) => void>();

	constructor(page: Page, logFailure: (message: string, details: Record<string, unknown>) => void) {
		this.#page = page;
		this.#logFailure = logFailure;
	}

	/** Install the page listeners exactly once. */
	observe(): void {
		if (this.#installed) return;
		this.#page.on("dialog", this.#onDialog);
		this.#page.on("framenavigated", this.#onFrameNavigated);
		this.#installed = true;
	}

	/** Remove listeners and forget any dialog that can no longer be handled. */
	dispose(): void {
		if (!this.#installed) return;
		this.#page.off("dialog", this.#onDialog);
		this.#page.off("framenavigated", this.#onFrameNavigated);
		this.#installed = false;
		this.#pending = undefined;
	}

	/** Return the current runtime dialog policy. */
	get policy(): DialogPolicy | undefined {
		return this.#policy;
	}

	/** Return a JSON-safe snapshot of the pending dialog. */
	state(): DialogState {
		const dialog = this.#pending;
		if (!dialog) return { open: false };
		const type = dialog.type();
		return {
			open: true,
			type,
			message: dialog.message(),
			...(type === "prompt" ? { defaultValue: dialog.defaultValue() } : {}),
		};
	}

	/**
	 * Resolve with the dialog's state once a confirm or prompt waits for a decision, at once when one already does.
	 * Stays pending after `signal` aborts.
	 */
	whenPending(signal: AbortSignal): Promise<DialogState> {
		const state = this.state();
		if (state.open) return Promise.resolve(state);
		const { promise, resolve } = Promise.withResolvers<DialogState>();
		const forget = (): void => {
			this.#waiters.delete(notify);
			signal.removeEventListener("abort", forget);
		};
		const notify = (pending: DialogState): void => {
			forget();
			resolve(pending);
		};
		if (signal.aborted) return promise;
		this.#waiters.add(notify);
		signal.addEventListener("abort", forget, { once: true });
		return promise;
	}

	/** Change the automatic policy and settle an already-pending decision when enabled. */
	async setPolicy(policy: DialogPolicy | null): Promise<void> {
		this.#policy = policy ?? undefined;
		if (!this.#policy || !this.#pending) return;
		await this.#settle(this.#pending, this.#policy === "accept", undefined);
	}

	/** Explicitly accept or dismiss the pending confirm or prompt. */
	async handle(options: { accept: boolean; text?: string }): Promise<void> {
		const dialog = this.#pending;
		if (!dialog) throw new ToolError("tab.handleDialog() found no pending confirm or prompt");
		await this.#settle(dialog, options.accept, options.text);
	}

	readonly #onDialog = (dialog: Dialog): void => {
		const policy = this.#policy;
		if (policy) {
			void this.#settle(dialog, policy === "accept", undefined).catch(error => this.#report(error, policy));
			return;
		}
		const type = dialog.type();
		if (type === "alert" || type === "beforeunload") {
			void this.#settle(dialog, true, undefined).catch(error => this.#report(error, "accept"));
			return;
		}
		this.#pending = dialog;
		const state = this.state();
		for (const notify of this.#waiters) notify(state);
	};

	readonly #onFrameNavigated = (frame: Frame): void => {
		if (frame === this.#page.mainFrame()) this.#pending = undefined;
	};

	async #settle(dialog: Dialog, accept: boolean, text: string | undefined): Promise<void> {
		try {
			if (accept) await dialog.accept(text);
			else await dialog.dismiss();
		} finally {
			if (this.#pending === dialog) this.#pending = undefined;
		}
	}

	#report(error: unknown, policy: DialogPolicy): void {
		this.#logFailure("Dialog auto-handler failed", {
			policy,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
