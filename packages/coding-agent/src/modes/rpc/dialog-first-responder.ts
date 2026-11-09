/**
 * First-responder dialogs for a terminal-hosted session that is also published
 * on its attach socket.
 *
 * `InteractiveMode` owns one instance for the process lifetime. Its TUI UI
 * contexts are wrapped before installation, so every `select` / `confirm` /
 * `input` / `editor` / `ask` request is presented on the terminal and, when at
 * least one socket client is attached, on every attached client at once. The
 * first surface that answers settles the shared promise and cancels the
 * sibling presentation; a client disconnecting never rejects a dialog the
 * terminal (or another client) can still answer.
 */
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionFormDialogResult,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "../../extensibility/extensions";
import { askFieldByField } from "../../tools/ask";

/** One dialog already issued to the socket transport, cancellable from here. */
export interface DialogRequestHandle<T> {
	/** Wire id; absent when the dialog options were already aborted, so nothing was sent. */
	readonly id: string | undefined;
	readonly promise: Promise<T>;
	/** Tell the clients to close this request; idempotent with the request's own cleanup. */
	cancel(): void;
}

/** The active socket publication's dialog transport. */
export interface DialogSocketBridge {
	/** Whether at least one client is attached that can present dialogs right now. */
	hasClients(): boolean;
	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions: ExtensionUIDialogOptions | undefined,
	): DialogRequestHandle<string | undefined>;
	confirm(
		title: string,
		message: string,
		dialogOptions: ExtensionUIDialogOptions | undefined,
	): DialogRequestHandle<boolean>;
	input(
		title: string,
		placeholder: string | undefined,
		dialogOptions: ExtensionUIDialogOptions | undefined,
	): DialogRequestHandle<string | undefined>;
	editor(
		title: string,
		prefill: string | undefined,
		dialogOptions: ExtensionUIDialogOptions | undefined,
		editorOptions: { promptStyle?: boolean } | undefined,
	): DialogRequestHandle<string | undefined>;
	ask(
		questions: ExtensionAskDialogQuestion[],
		dialogOptions: ExtensionUIDialogOptions | undefined,
	): DialogRequestHandle<ExtensionAskDialogResult | undefined>;
	/** Broadcast a `cancel` frame targeting `id` to every attached client. */
	dismiss(id: string): void;
}

export class DialogFirstResponder {
	#bridge: DialogSocketBridge | undefined;
	#askDialogEnabled = false;
	#active = new Set<AbortController>();

	/** Install the bridge of the session publication now serving this process. */
	attach(bridge: DialogSocketBridge): void {
		this.#bridge = bridge;
	}

	/**
	 * The publication closed. Outstanding races are dismissed (both presentations
	 * settle) and a later TUI dialog falls back to the terminal alone; a client
	 * disconnect alone never reaches this path.
	 */
	detach(bridge: DialogSocketBridge): void {
		if (this.#bridge !== bridge) return;
		this.#bridge = undefined;
		for (const controller of Array.from(this.#active)) controller.abort();
		this.#active.clear();
	}

	/** Whether attached clients opted in to receiving `ask` dialogs (`set_ask_dialog`). */
	setAskDialogEnabled(enabled: boolean): void {
		this.#askDialogEnabled = enabled;
	}

	/** Whether at least one socket view is attached and can answer a dialog right now. */
	hasAttachedClients(): boolean {
		return this.#bridge?.hasClients() ?? false;
	}

	select(
		tui: (dialogOptions?: ExtensionUIDialogOptions) => Promise<string | undefined>,
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.#race(dialogOptions, tui, (bridge, merged) => bridge.select(title, options, merged));
	}

	confirm(
		tui: (dialogOptions?: ExtensionUIDialogOptions) => Promise<boolean>,
		title: string,
		message: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		return this.#race(dialogOptions, tui, (bridge, merged) => bridge.confirm(title, message, merged));
	}

	input(
		tui: (dialogOptions?: ExtensionUIDialogOptions) => Promise<string | undefined>,
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.#race(dialogOptions, tui, (bridge, merged) => bridge.input(title, placeholder, merged));
	}

	editor(
		tui: (dialogOptions?: ExtensionUIDialogOptions) => Promise<string | undefined>,
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return this.#race(dialogOptions, tui, (bridge, merged) => bridge.editor(title, prefill, merged, editorOptions));
	}

	/**
	 * The terminal always presents `ask`; attached clients join only after
	 * opting in with `set_ask_dialog`.
	 */
	askDialog(
		tui: (dialogOptions?: ExtensionUIDialogOptions) => Promise<ExtensionAskDialogResult | undefined>,
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> {
		if (!this.#askDialogEnabled) return tui(dialogOptions);
		return this.#race(dialogOptions, tui, (bridge, merged) => bridge.ask(questions, merged));
	}

	/** Keep the terminal's whole form while sockets use the standard RPC field fallback. */
	formDialog(
		tui: (dialogOptions?: ExtensionUIDialogOptions) => Promise<ExtensionFormDialogResult | undefined>,
		html: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionFormDialogResult | undefined> {
		return this.#race(dialogOptions, tui, (bridge, options) => {
			const complete = async <T>(request: DialogRequestHandle<T>): Promise<T> => {
				const value = await request.promise;
				if (request.id !== undefined) bridge.dismiss(request.id);
				return value;
			};
			return {
				id: undefined,
				promise: askFieldByField(
					{
						select: (title, items, fieldOptions) => complete(bridge.select(title, items, fieldOptions)),
						input: (title, placeholder, fieldOptions) => complete(bridge.input(title, placeholder, fieldOptions)),
						editor: (title, prefill, fieldOptions, editorOptions) =>
							complete(bridge.editor(title, prefill, fieldOptions, editorOptions)),
					},
					parseHtmlForm(html),
					options.timeout,
					options.signal!,
				),
				cancel: () => {},
			};
		});
	}

	async #race<T>(
		dialogOptions: ExtensionUIDialogOptions | undefined,
		tui: (dialogOptions?: ExtensionUIDialogOptions) => Promise<T>,
		socket: (bridge: DialogSocketBridge, options: ExtensionUIDialogOptions) => DialogRequestHandle<T>,
	): Promise<T> {
		const bridge = this.#bridge;
		// An already-aborted dialog is answered by the terminal's own dismissal path.
		if (!bridge?.hasClients() || dialogOptions?.signal?.aborted) return tui(dialogOptions);

		const controller = new AbortController();
		this.#active.add(controller);
		const signal =
			dialogOptions?.signal === undefined
				? controller.signal
				: AbortSignal.any([dialogOptions.signal, controller.signal]);
		let timeoutFired = false;
		const options: ExtensionUIDialogOptions = {
			...dialogOptions,
			signal,
			...(dialogOptions?.onTimeout
				? {
						onTimeout: () => {
							if (timeoutFired) return;
							timeoutFired = true;
							dialogOptions.onTimeout?.();
						},
					}
				: {}),
		};

		const request = socket(bridge, options);
		const tuiSettled = tui(options).then(
			value => ({ source: "tui" as const, ok: true as const, value }),
			error => ({ source: "tui" as const, ok: false as const, error }),
		);
		const socketSettled = request.promise.then(
			value => ({ source: "socket" as const, ok: true as const, value }),
			error => ({ source: "socket" as const, ok: false as const, error }),
		);
		const first = await Promise.race([tuiSettled, socketSettled]);
		this.#active.delete(controller);
		// Settles the losing side: the terminal selector closes, and an outstanding
		// wire request broadcasts its own cancel frame to the clients.
		controller.abort();
		if (first.source === "socket" && first.ok && request.id !== undefined) bridge.dismiss(request.id);
		if (!first.ok) throw first.error;
		return first.value;
	}
}
