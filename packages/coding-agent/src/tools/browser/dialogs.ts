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

/** Runtime controller for automatic and explicitly handled JavaScript dialogs. */
export class RuntimeDialogController {
	readonly #page: Page;
	readonly #logFailure: (message: string, details: Record<string, unknown>) => void;
	#policy: DialogPolicy | undefined;
	#pending: Dialog | undefined;
	#installed = false;

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
