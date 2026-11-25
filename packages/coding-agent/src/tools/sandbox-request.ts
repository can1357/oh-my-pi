import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import sandboxRequestDescription from "../prompts/tools/sandbox-request.md" with { type: "text" };
import sandboxRequestResult from "../prompts/tools/sandbox-request-result.md" with { type: "text" };
import { SandboxRuntime } from "../sandbox/runtime";
import type { SandboxAccessKind, SandboxAccessOutcome } from "../sandbox/types";
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

/** What a `sandbox_request` asks for. */
export type SandboxRequestKind = SandboxAccessKind;

/** The verb each kind reads with ("write to <path>"), for the card and the access dialog. */
export const SANDBOX_KIND_VERBS: Record<SandboxRequestKind, string> = {
	write: "write to",
	read: "read",
	host: "connect to",
	exec: "perform",
};

/** The request's outcome plus what was asked. */
export type SandboxRequestToolDetails = {
	kind?: SandboxRequestKind;
	intent?: string;
	command?: string;
	alternative?: string;
} & SandboxAccessOutcome;

const sandboxRequestSchema = type({
	kind: type("'write' | 'read' | 'host' | 'exec'").describe(
		"write: create/change files under a directory; read: read a file or directory; host: connect to a hostname; exec: let omp perform an action outside the sandbox (session only)",
	),
	target: type("string").describe(
		"The narrowest path (absolute, ~, or relative to cwd), exact hostname, or the exec target a refusal names",
	),
	intent: type("string").describe("What you are doing and why this exact target is needed, for the user"),
	"command?": type("string").describe("The command that needs the access, verbatim"),
	"alternative?": type("string").describe("What you will do if the user denies"),
});

type SandboxRequestParams = typeof sandboxRequestSchema.infer;

const ACCESS_WORDS: Record<SandboxAccessKind, string> = {
	write: "writable for contained commands and file tools",
	read: "readable for contained commands and file tools",
	host: "reachable for contained commands",
	exec: "allowed for omp to perform outside the sandbox",
};

/** The model-facing result text for `outcome`. */
function sandboxRequestResultText(kind: SandboxAccessKind, outcome: SandboxAccessOutcome): string {
	return prompt.render(sandboxRequestResult, { ...outcome, access: ACCESS_WORDS[kind] }).trim();
}

/**
 * Asks the user, through the sandbox runtime's access approver, to let contained commands write,
 * read or reach one exact target, or omp perform one `exec` action outside the sandbox. Available while the sandbox is enabled in a process where someone
 * answers access requests (see `SandboxRuntime.answersAccessRequests`); the dialog is the
 * decision, so the call itself sits in the lowest approval tier and never asks twice.
 */
export class SandboxRequestTool implements AgentTool<typeof sandboxRequestSchema, SandboxRequestToolDetails> {
	readonly name = "sandbox_request";
	readonly approval = "read" as const;
	readonly label = "Sandbox Request";
	readonly description = sandboxRequestDescription;
	readonly parameters = sandboxRequestSchema;
	readonly strict = false;
	/** Like `ask`: two requests in one message are asked one after the other. */
	readonly concurrency = "exclusive";
	readonly summary = "Ask the user to allow a path or host for sandboxed commands, or an action outside the sandbox";

	constructor(private readonly session: ToolSession) {}

	/** Absent where nobody can answer (print mode, ACP): the prompt then says to tell the user instead. */
	static createIf(session: ToolSession): SandboxRequestTool | null {
		return SandboxRuntime.answersAccessRequests() ? new SandboxRequestTool(session) : null;
	}

	async execute(
		_id: string,
		params: SandboxRequestParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SandboxRequestToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SandboxRequestToolDetails>> {
		throwIfAborted(signal);
		const runtime = await SandboxRuntime.for(this.session.cwd);
		let outcome: SandboxAccessOutcome;
		try {
			outcome = await runtime.requestAccess({ ...params, cwd: this.session.cwd }, signal);
		} catch (error) {
			throwIfAborted(signal);
			throw error;
		}
		const details: SandboxRequestToolDetails = {
			...outcome,
			kind: params.kind,
			intent: params.intent,
			...(params.command !== undefined ? { command: params.command } : {}),
			...(params.alternative !== undefined ? { alternative: params.alternative } : {}),
		};
		return { content: [{ type: "text", text: sandboxRequestResultText(params.kind, outcome) }], details };
	}
}
