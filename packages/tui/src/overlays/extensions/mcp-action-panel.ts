import { BracketedPasteHandler, decodeReencodedPasteControls } from "../../bracketed-paste";
import { extractPrintableText, matchesKey } from "../../keys";
import { matchesSelectDown, matchesSelectUp } from "../../keybinding-matchers";
import { bottomBorder, row, topBorder } from "../../chrome/overlay-box";
import { theme } from "../../theme";
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

export class MCPActionPanel implements Component {
	readonly #pasteHandler = new BracketedPasteHandler({ byteLimit: 64 * 1024 });
	#state: MCPActionPanelState;
	#selectedIndex = 0;
	#statusMessage = "";
	#authorization?: { url: string; instructions?: string };
	#confirmationAction?: MCPActionId;
	#running?: { action: MCPActionId; controller: AbortController };
	#pendingInput?: PendingInput;

	onClose?: () => void;
	onChanged?: () => void;
	onRequestRender?: () => void;

	constructor(
		readonly extension: Extension,
		state: MCPActionPanelState,
		readonly runtime: MCPActionPanelRuntime,
		readonly terminalHeight: number,
	) {
		this.#state = state;
		this.#selectedIndex = this.#firstEnabledIndex();
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || this.terminalHeight || 24);
		const lines: string[] = [topBorder(width, `MCP Server · ${this.#state.name}`)];
		const push = (text = "") => lines.push(row(text, width));
		const statusColor =
			this.#state.connectionStatus === "connected"
				? "success"
				: this.#state.connectionStatus === "connecting"
					? "warning"
					: "muted";

		push(`${theme.fg("dim", "Status:")} ${theme.fg(statusColor, this.#state.connectionStatus)}`);
		push(`${theme.fg("dim", "Transport:")} ${this.#state.transport}`);
		push(`${theme.fg("dim", "Authentication:")} ${this.#state.authentication}`);
		push(`${theme.fg("dim", "Source:")} ${this.#state.source}`);
		push(
			`${theme.fg("dim", "Capabilities:")} ${this.#state.tools} tools · ${this.#state.prompts} prompts · ${this.#state.resources} resources`,
		);
		if (this.#state.lastError) push(`${theme.fg("error", "Last error:")} ${this.#state.lastError}`);
		push();
		push(theme.bold("Actions"));
		for (const [index, action] of this.#state.actions.entries()) {
			const selected = index === this.#selectedIndex;
			const marker = selected ? theme.fg("accent", ">") : " ";
			const label = action.enabled ? action.label : theme.fg("dim", action.label);
			const suffix = action.enabled ? action.description : (action.disabledReason ?? "Unavailable");
			push(`${marker} ${label} ${theme.fg("dim", `· ${suffix}`)}`);
		}
		push();

		if (this.#pendingInput) {
			push(theme.fg("warning", "Paste the OAuth redirect URL or authorization code, then press Enter:"));
			push(theme.fg("accent", `> ${this.#pendingInput.buffer}`));
		} else if (this.#authorization) {
			push(theme.fg("warning", "Waiting for OAuth authorization"));
			push(this.#authorization.instructions ?? "Complete authentication in the browser.");
			push(theme.fg("dim", this.#authorization.url));
		}
		if (this.#confirmationAction) {
			push(theme.fg("warning", "Press Enter again to confirm this action."));
		}
		if (this.#statusMessage) push(this.#statusMessage);

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
				this.#statusMessage = theme.fg("muted", "Cancelling action...");
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
		this.#cancelRunning();
		this.#rejectManualInput(new Error("MCP action panel closed"));
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
			this.#statusMessage = theme.fg("warning", `${action.label} requires confirmation.`);
			this.onRequestRender?.();
			return;
		}

		this.#confirmationAction = undefined;
		this.#authorization = undefined;
		const controller = new AbortController();
		this.#running = { action: action.id, controller };
		this.#statusMessage = theme.fg("muted", `${action.label}...`);
		this.onRequestRender?.();
		try {
			const message = await this.runtime.runAction(this.extension, action.id, {
				signal: controller.signal,
				onProgress: progress => {
					this.#statusMessage = theme.fg("muted", progress);
					this.onRequestRender?.();
				},
				onAuthorization: info => {
					this.#authorization = info;
					this.onRequestRender?.();
				},
				requestManualInput: signal => this.#requestManualInput(signal),
			});
			this.#statusMessage = theme.fg("success", message);
			this.#authorization = undefined;
			this.#state = await this.runtime.loadState(this.extension);
			this.#selectedIndex = Math.min(this.#selectedIndex, Math.max(0, this.#state.actions.length - 1));
			this.onChanged?.();
		} catch (error) {
			this.#authorization = undefined;
			this.#statusMessage = isCancellation(error)
				? theme.fg("muted", "Action cancelled.")
				: theme.fg("error", error instanceof Error ? error.message : String(error));
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
