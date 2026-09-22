import { BracketedPasteHandler, decodeReencodedPasteControls } from "../../bracketed-paste";
import { extractPrintableText, matchesKey } from "../../keys";
import { matchesSelectDown, matchesSelectUp } from "../../keybinding-matchers";
import { bottomBorder, row, topBorder } from "../../chrome/overlay-box";
import { theme } from "../../theme";
import { sanitizeDisplayLine, sanitizeDisplayText } from "./display-text";
import type { Component } from "../../tui";
import type { Extension } from "./types";

export type MCPActionId = "test" | "reconnect" | "reauthenticate" | "clear-authentication" | "enable" | "disable";

export interface MCPActionItem {
	id: MCPActionId;
	label: string;
	description: string;
	enabled: boolean;
	disabledReason?: string;
	requiresConfirmation?: boolean;
}

export interface MCPActionPanelState {
	name: string;
	connectionStatus: "connected" | "connecting" | "disconnected" | "disabled";
	transport: string;
	source: string;
	authentication: string;
	tools: number;
	prompts: number;
	resources: number;
	lastError?: string;
	actions: MCPActionItem[];
}

export interface MCPActionExecutionContext {
	signal: AbortSignal;
	onProgress(message: string): void;
	onAuthorization(info: { url: string; instructions?: string }): void;
	requestManualInput(signal: AbortSignal): Promise<string>;
}

export interface MCPActionPanelRuntime {
	loadState(extension: Extension): Promise<MCPActionPanelState>;
	runAction(extension: Extension, action: MCPActionId, context: MCPActionExecutionContext): Promise<string>;
}

interface PendingInput {
	buffer: string;
	resolve(value: string): void;
	reject(error: Error): void;
	cleanup(): void;
}

function isCancellation(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "MCPOAuthCancelledError");
}
type StatusColor = "muted" | "warning" | "success" | "error";

interface StatusMessage {
	text: string;
	color: StatusColor;
}

function sanitizePanelState(state: MCPActionPanelState): MCPActionPanelState {
	return {
		...state,
		name: sanitizeDisplayLine(state.name),
		transport: sanitizeDisplayLine(state.transport),
		source: sanitizeDisplayLine(state.source),
		authentication: sanitizeDisplayLine(state.authentication),
		lastError: state.lastError ? sanitizeDisplayLine(state.lastError) : undefined,
		actions: state.actions.map(action => ({
			...action,
			label: sanitizeDisplayLine(action.label),
			description: sanitizeDisplayLine(action.description),
			disabledReason: action.disabledReason ? sanitizeDisplayLine(action.disabledReason) : undefined,
		})),
	};
}

export class MCPActionPanel implements Component {
	readonly #pasteHandler = new BracketedPasteHandler({ byteLimit: 64 * 1024 });
	#state: MCPActionPanelState;
	#selectedIndex = 0;
	#statusMessage?: StatusMessage;
	#authorization?: { url: string; instructions?: string };
	#confirmationAction?: MCPActionId;
	#running?: { action: MCPActionId; controller: AbortController };
	#pendingInput?: PendingInput;
	#reloadToken = 0;
	#disposed = false;

	onClose?: () => void;
	onChanged?: () => void;
	onRequestRender?: () => void;

	constructor(
		readonly extension: Extension,
		state: MCPActionPanelState,
		readonly runtime: MCPActionPanelRuntime,
		readonly terminalHeight: number,
	) {
		this.#state = sanitizePanelState(state);
		this.#selectedIndex = this.#firstEnabledIndex();
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || this.terminalHeight || 24);
		const lines: string[] = [topBorder(width, `MCP Server · ${sanitizeDisplayLine(this.#state.name)}`)];
		const push = (text = "") => lines.push(row(text, width));
		const statusColor =
			this.#state.connectionStatus === "connected"
				? "success"
				: this.#state.connectionStatus === "connecting"
					? "warning"
					: "muted";
		const infoRows = [
			`${theme.fg("dim", "Status:")} ${theme.fg(statusColor, this.#state.connectionStatus)} ${theme.fg("dim", `· Transport: ${sanitizeDisplayLine(this.#state.transport)}`)}`,
			`${theme.fg("dim", "Authentication:")} ${sanitizeDisplayLine(this.#state.authentication)}`,
			`${theme.fg("dim", "Source:")} ${sanitizeDisplayLine(this.#state.source)}`,
			`${theme.fg("dim", "Capabilities:")} ${this.#state.tools} tools · ${this.#state.prompts} prompts · ${this.#state.resources} resources`,
		];
		if (this.#state.lastError) {
			infoRows.push(`${theme.fg("error", "Last error:")} ${sanitizeDisplayLine(this.#state.lastError)}`);
		}
		for (const info of infoRows) push(info);

		const transientRows: string[] = [];
		if (this.#pendingInput) {
			transientRows.push(
				theme.fg("warning", "Paste the OAuth redirect URL or authorization code, then press Enter:"),
			);
			transientRows.push(theme.fg("accent", `> ${sanitizeDisplayLine(this.#pendingInput.buffer)}`));
		} else if (this.#authorization) {
			transientRows.push(theme.fg("warning", "Waiting for OAuth authorization"));
			transientRows.push(
				sanitizeDisplayLine(this.#authorization.instructions ?? "Complete authentication in the browser."),
			);
			transientRows.push(theme.fg("dim", sanitizeDisplayLine(this.#authorization.url)));
		}
		if (this.#confirmationAction) {
			transientRows.push(theme.fg("warning", "Press Enter again to confirm this action."));
		}
		if (this.#statusMessage) {
			transientRows.push(
				...sanitizeDisplayText(this.#statusMessage.text)
					.split("\n")
					.map(line => theme.fg(this.#statusMessage!.color, line)),
			);
		}

		// Top border, server summary, Actions heading, footer, and bottom border are
		// fixed. Transient OAuth/result rows take precedence over the action list;
		// the selected action stays inside the remaining window.
		const variableRows = Math.max(1, height - 1 - infoRows.length - 1 - 2);
		const actionCount = this.#state.actions.length;
		const maxTransientRows = Math.max(0, variableRows - (actionCount > 0 ? 1 : 0));
		const visibleTransientRows = transientRows.slice(0, maxTransientRows);
		const actionCapacity = Math.max(0, variableRows - visibleTransientRows.length);
		const actionWindowSize = Math.min(actionCount, actionCapacity);
		const maxWindowStart = Math.max(0, actionCount - actionWindowSize);
		const actionWindowStart = Math.min(
			maxWindowStart,
			Math.max(0, this.#selectedIndex - Math.floor(actionWindowSize / 2)),
		);
		const actionWindowEnd = actionWindowStart + actionWindowSize;
		const actionWindowLabel =
			actionWindowSize < actionCount
				? `Actions (${actionWindowStart + 1}-${actionWindowEnd} of ${actionCount})`
				: "Actions";
		push(theme.bold(actionWindowLabel));
		for (let index = actionWindowStart; index < actionWindowEnd; index++) {
			const action = this.#state.actions[index]!;
			const selected = index === this.#selectedIndex;
			const marker = selected ? theme.fg("accent", ">") : " ";
			const cleanLabel = sanitizeDisplayLine(action.label);
			const label = action.enabled ? cleanLabel : theme.fg("dim", cleanLabel);
			const suffix = action.enabled
				? sanitizeDisplayLine(action.description)
				: sanitizeDisplayLine(action.disabledReason ?? "Unavailable");
			push(`${marker} ${label} ${theme.fg("dim", `· ${suffix}`)}`);
		}
		for (const transient of visibleTransientRows) push(transient);

		const footer = this.#running
			? " Esc: cancel action · Ctrl+C: close"
			: " ↑/↓: select · Enter: run · Esc: back · Ctrl+C: close";
		while (lines.length < height - 2) push();
		lines.push(row(theme.fg("dim", footer), width));
		lines.push(bottomBorder(width));
		return lines.slice(0, height);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.#cancelRunning();
			this.onClose?.();
			return;
		}
		if (this.#pendingInput) {
			this.#handleManualInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.#running) {
				this.#cancelRunning();
				this.#statusMessage = { text: "Cancelling action...", color: "muted" };
				this.onRequestRender?.();
				return;
			}
			this.onClose?.();
			return;
		}
		if (this.#running) return;
		if (matchesSelectUp(data)) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			void this.#activateSelected();
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.#disposed = true;
		this.#reloadToken++;
		this.#cancelRunning();
		this.#rejectManualInput(new Error("MCP action panel closed"));
	}

	/** Reload live MCP state without allowing an older request to overwrite a newer lifecycle event. */
	async reloadState(): Promise<void> {
		const reloadToken = ++this.#reloadToken;
		const selectedAction = this.#state.actions[this.#selectedIndex]?.id;
		const nextState = sanitizePanelState(await this.runtime.loadState(this.extension));
		if (this.#disposed || reloadToken !== this.#reloadToken) return;
		this.#state = nextState;
		const selectedIndex = selectedAction
			? this.#state.actions.findIndex(action => action.id === selectedAction && action.enabled)
			: -1;
		this.#selectedIndex = selectedIndex >= 0 ? selectedIndex : this.#firstEnabledIndex();
		if (
			this.#confirmationAction &&
			!this.#state.actions.some(action => action.id === this.#confirmationAction && action.enabled)
		) {
			this.#confirmationAction = undefined;
		}
		this.onRequestRender?.();
	}

	#firstEnabledIndex(): number {
		const index = this.#state.actions.findIndex(action => action.enabled);
		return index >= 0 ? index : 0;
	}

	#moveSelection(direction: -1 | 1): void {
		if (this.#state.actions.length === 0) return;
		for (let step = 1; step <= this.#state.actions.length; step++) {
			const index =
				(this.#selectedIndex + direction * step + this.#state.actions.length) % this.#state.actions.length;
			if (this.#state.actions[index]?.enabled) {
				this.#selectedIndex = index;
				this.#confirmationAction = undefined;
				this.onRequestRender?.();
				return;
			}
		}
	}

	async #activateSelected(): Promise<void> {
		const action = this.#state.actions[this.#selectedIndex];
		if (!action?.enabled) return;
		if (action.requiresConfirmation && this.#confirmationAction !== action.id) {
			this.#confirmationAction = action.id;
			this.#statusMessage = {
				text: sanitizeDisplayText(`${action.label} requires confirmation.`),
				color: "warning",
			};
			this.onRequestRender?.();
			return;
		}

		this.#confirmationAction = undefined;
		this.#authorization = undefined;
		const controller = new AbortController();
		this.#running = { action: action.id, controller };
		this.#statusMessage = { text: sanitizeDisplayText(`${action.label}...`), color: "muted" };
		this.onRequestRender?.();
		try {
			const message = await this.runtime.runAction(this.extension, action.id, {
				signal: controller.signal,
				onProgress: progress => {
					this.#statusMessage = { text: sanitizeDisplayText(progress), color: "muted" };
					this.onRequestRender?.();
				},
				onAuthorization: info => {
					this.#authorization = {
						url: sanitizeDisplayLine(info.url),
						instructions: info.instructions ? sanitizeDisplayLine(info.instructions) : undefined,
					};
					this.onRequestRender?.();
				},
				requestManualInput: signal => this.#requestManualInput(signal),
			});
			this.#statusMessage = { text: sanitizeDisplayText(message), color: "success" };
			this.#authorization = undefined;
			await this.reloadState();
			this.onChanged?.();
		} catch (error) {
			this.#authorization = undefined;
			this.#statusMessage = isCancellation(error)
				? { text: "Action cancelled.", color: "muted" }
				: {
						text: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
						color: "error",
					};
		} finally {
			this.#running = undefined;
			this.#rejectManualInput(new Error("OAuth input no longer required"));
			this.onRequestRender?.();
		}
	}

	#requestManualInput(signal: AbortSignal): Promise<string> {
		this.#rejectManualInput(new Error("OAuth input superseded"));
		if (signal.aborted) return Promise.reject(new DOMException("OAuth input cancelled", "AbortError"));
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const onAbort = () => this.#rejectManualInput(new DOMException("OAuth input cancelled", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
		this.#pendingInput = {
			buffer: "",
			resolve,
			reject,
			cleanup: () => signal.removeEventListener("abort", onAbort),
		};
		this.onRequestRender?.();
		return promise;
	}

	#handleManualInput(data: string): void {
		const pending = this.#pendingInput;
		if (!pending) return;
		const paste = this.#pasteHandler.process(data);
		if (paste.handled) {
			if (paste.pasteContent !== undefined) {
				pending.buffer += decodeReencodedPasteControls(paste.pasteContent)
					.normalize("NFC")
					.replace(/[\x00-\x1F\x7F]/g, "")
					.trim();
			}
			this.onRequestRender?.();
			if (paste.remaining) this.#handleManualInput(paste.remaining);
			return;
		}
		if (matchesKey(data, "escape")) {
			this.#cancelRunning();
			return;
		}
		if (matchesKey(data, "backspace")) {
			pending.buffer = pending.buffer.slice(0, -1);
			this.onRequestRender?.();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const value = pending.buffer.trim();
			if (value.length === 0) return;
			pending.cleanup();
			this.#pendingInput = undefined;
			pending.resolve(value);
			this.onRequestRender?.();
			return;
		}
		const printableText = extractPrintableText(data);
		if (printableText !== undefined) {
			pending.buffer += printableText;
			this.onRequestRender?.();
		}
	}

	#cancelRunning(): void {
		this.#running?.controller.abort(new DOMException("MCP action cancelled", "AbortError"));
		this.#rejectManualInput(new DOMException("MCP action cancelled", "AbortError"));
	}

	#rejectManualInput(error: Error): void {
		const pending = this.#pendingInput;
		if (!pending) return;
		pending.cleanup();
		this.#pendingInput = undefined;
		pending.reject(error);
	}
}
