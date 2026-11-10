import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { SandboxRequestToolDetails } from "@oh-my-pi/pi-tui/tools/sandbox-request";
import { prompt } from "@oh-my-pi/pi-utils";
import sandboxRequestDescription from "../prompts/tools/sandbox-request.md" with { type: "text" };
import sandboxRequestResult from "../prompts/tools/sandbox-request-result.md" with { type: "text" };
import { type SandboxAccessKind, type SandboxAccessOutcome, SandboxRuntime } from "../sandbox/runtime";
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

const sandboxRequestSchema = type({
	kind: type("'write' | 'read' | 'host'").describe(
		"write: create/change files under a directory; read: read a file or directory; host: connect to a hostname",
	),
	target: type("string").describe("The narrowest path (absolute, ~, or relative to cwd) or exact hostname"),
	intent: type("string").describe("What you are doing and why this exact target is needed, for the user"),
	"command?": type("string").describe("The command that needs the access, verbatim"),
	"alternative?": type("string").describe("What you will do if the user denies"),
});

export type SandboxRequestParams = typeof sandboxRequestSchema.infer;

const ACCESS_WORDS: Record<SandboxAccessKind, string> = { write: "writable", read: "readable", host: "reachable" };

/** The model-facing result text for `outcome`. */
export function sandboxRequestResultText(kind: SandboxAccessKind, outcome: SandboxAccessOutcome): string {
	return prompt
		.render(sandboxRequestResult, {
			...outcome,
			access: ACCESS_WORDS[kind],
			granted: outcome.status === "granted",
			always: outcome.status === "granted" && outcome.scope === "always",
			alreadyAllowed: outcome.status === "already-allowed",
			denied: outcome.status === "denied",
			instructed: outcome.status === "instructed",
			refused: outcome.status === "refused",
		})
		.trim();
}

/**
 * Asks the user, through the sandbox runtime's access approver, to let contained commands write,
 * read or reach one exact target. Available while the sandbox is enabled; the dialog is the
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
	readonly summary = "Ask the user to allow a path or host for sandboxed commands";

	constructor(private readonly session: ToolSession) {}

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
