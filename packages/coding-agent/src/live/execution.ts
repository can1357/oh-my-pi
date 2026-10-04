import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { EvalPreludeDefinition } from "../eval/preludes";
import { invokeEvalPrelude } from "../eval/preludes";
import type { AgentSession } from "../session/agent-session";
import type { ToolSession } from "../tools";
import { createComputerPrelude } from "../tools/computer";
import { cfgComputerEnabled } from "../tools/settings";
import { cfgLiveComputer } from "./settings";

export interface GeminiLiveExecutionResult {
	text: string;
	images: Array<{ data: string; mimeType: string }>;
}

interface ComputerRunDetails {
	value?: unknown;
}

function createToolSession(
	session: AgentSession,
	getEvalPreludes: () => readonly EvalPreludeDefinition[],
): ToolSession {
	return {
		get cwd() {
			return session.sessionManager.getCwd();
		},
		hasUI: false,
		settings: session.settings,
		getSessionSpawns: () => null,
		getSessionFile: () => session.sessionFile ?? null,
		getEvalSessionId: () => session.getEvalSessionId(),
		getEvalKernelOwnerId: () => session.getEvalKernelOwnerId(),
		getSessionId: () => session.sessionId,
		getToolByName: name => session.getToolByName(name),
		getToolForEvalBridge: name => session.getToolForEvalBridge(name),
		getEvalBridgeToolNames: () => session.getEvalBridgeToolNames(),
		getEvalPreludes,
		getActiveModel: () => session.model ?? undefined,
	};
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function executionResult(result: AgentToolResult<unknown>, includeDetailValue = false): GeminiLiveExecutionResult {
	const textParts = result.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map(content => content.text);
	if (includeDetailValue) {
		const details = result.details as ComputerRunDetails | undefined;
		if (details?.value !== undefined) textParts.push(stringifyReturnValue(details.value));
	}
	const images = result.content
		.filter(
			(content): content is { type: "image"; data: string; mimeType: string } =>
				content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
		)
		.map(({ data, mimeType }) => ({ data, mimeType }));
	return { text: textParts.join("\n"), images };
}

/** Direct Gemini Live code and computer execution through the owning AgentSession's capabilities. */
export class GeminiLiveExecution {
	readonly codeEnabled: boolean;
	readonly desktopEnabled: boolean;
	readonly #session: AgentSession;
	readonly #desktopToolSession: ToolSession | undefined;
	readonly #computerPrelude: EvalPreludeDefinition | undefined;
	#closed = false;

	constructor(session: AgentSession, desktopEnabled: boolean) {
		this.#session = session;
		this.codeEnabled = session.getToolForEvalBridge("eval") !== undefined;
		let desktopToolSession: ToolSession | undefined;
		let computerPrelude: EvalPreludeDefinition | undefined;
		if (desktopEnabled && cfgComputerEnabled.get(session.settings) === true) {
			const toolSession = createToolSession(session, () => {
				const current = session.getEvalPreludes().filter(candidate => candidate.name !== "computer");
				return computerPrelude ? [computerPrelude, ...current] : current;
			});
			desktopToolSession = toolSession;
			const basePrelude = createComputerPrelude(toolSession);
			computerPrelude = {
				...basePrelude,
				enabled: () => cfgLiveComputer.get(session.settings) === true && basePrelude.enabled?.() !== false,
			};
		}
		this.#desktopToolSession = desktopToolSession;
		this.#computerPrelude = computerPrelude;
		this.desktopEnabled = computerPrelude !== undefined;
	}

	async executeCode(code: string, language: "js" | "py", signal?: AbortSignal): Promise<GeminiLiveExecutionResult> {
		if (this.#closed) throw new ToolError("Gemini Live execution is closed");
		if (code.trim().length === 0) throw new ToolError("Gemini Live code must not be empty");
		signal?.throwIfAborted();
		const tool = this.#session.getToolForEvalBridge("eval");
		if (!tool) throw new ToolError("Gemini Live code execution is not enabled in the current session");
		const result = await tool.execute(
			`gemini-live-execute-${crypto.randomUUID()}`,
			{ language, code, foreground: true },
			signal,
		);
		signal?.throwIfAborted();
		if (result.isError === true) {
			throw new ToolError(executionResult(result).text || "Gemini Live code execution failed");
		}
		return executionResult(result);
	}

	async executeDesktop(code: string, signal?: AbortSignal, readOnly = false): Promise<GeminiLiveExecutionResult> {
		if (this.#closed) throw new ToolError("Gemini Live execution is closed");
		if (code.trim().length === 0) throw new ToolError("Gemini Live desktop code must not be empty");
		if (!this.desktopEnabled || !this.#desktopToolSession) {
			throw new ToolError("Gemini Live desktop execution is not enabled");
		}
		const result = await invokeEvalPrelude(
			"computer",
			{ action: "run", code, read_only: readOnly },
			{
				session: this.#desktopToolSession,
				toolCallId: `gemini-live-desktop-${crypto.randomUUID()}`,
				signal,
			},
		);
		return executionResult(result, true);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const prelude = this.#computerPrelude;
		const toolSession = this.#desktopToolSession;
		if (!prelude || !toolSession) return;
		await prelude.invoke(
			{ action: "close" },
			{ session: toolSession, toolCallId: `gemini-live-desktop-close-${crypto.randomUUID()}` },
		);
	}
}
