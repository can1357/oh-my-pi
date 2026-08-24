/**
 * Deterministic, zero-cost "model" for scripts/acp-stress-matrix.sh (and
 * any other acp-probe run against a real `omp acp` subprocess).
 *
 * Registers a provider whose `streamSimple` never leaves the process: it
 * inspects the conversation directly and returns the exact tool call the
 * stress-matrix prompts ask for, verbatim, then ends the turn on the next
 * call. No network, no API key, no per-token cost, no risk of a real model
 * "helpfully" rewriting the requested command — e.g. silently appending a
 * `> /dev/null` redirect to "simplify" its output before running it.
 *
 * Usage: pass as an extension to the spawned `omp` process and select its
 * model:
 *   --extension <this file> --model stress-mock/stress-mock
 */
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { ExtensionAPI } from "../src/extensibility/extensions/types";

const STRESS_MOCK_API = "stress-mock" as Api;

interface Decision {
	tool?: "bash" | "eval";
	args?: Record<string, unknown>;
	text: string;
}

function lastUserMessageText(messages: readonly Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		return m.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}
	return undefined;
}

/** Parses the stress-matrix's templated prompts into an exact tool call. Falls
 * back to a plain text reply for anything else (e.g. a follow-up turn) so the
 * agent loop always terminates instead of hanging on an unrecognized prompt. */
function decide(context: Context): Decision {
	const messages = context.messages;
	const last = messages[messages.length - 1];
	// A tool result is already in the transcript: report it and end the turn.
	if (last?.role === "toolResult") {
		return { text: "Done." };
	}

	const text = lastUserMessageText(messages);
	if (text) {
		const exitCodeMatch =
			/run exactly this command, with no modification, and report only its exit code:\s*([\s\S]+)$/.exec(text);
		if (exitCodeMatch) {
			return { tool: "bash", args: { command: exitCodeMatch[1]!.trim() }, text: "Exit code: 0" };
		}
		const printedMatch =
			/run exactly this Python code, with no modification, and report only what it printed:\s*([\s\S]+)$/.exec(text);
		if (printedMatch) {
			return { tool: "eval", args: { language: "py", code: printedMatch[1]!.trim() }, text: "Printed." };
		}
		const useBashMatch = /[Uu]se the bash tool to run:\s*([\s\S]+)$/.exec(text);
		if (useBashMatch) {
			return { tool: "bash", args: { command: useBashMatch[1]!.trim() }, text: "Ran it." };
		}
		const runExactBashMatch = /Run this exact command with the bash tool, pty false:\s*([\s\S]+)$/.exec(text);
		if (runExactBashMatch) {
			return { tool: "bash", args: { command: runExactBashMatch[1]!.trim(), pty: false }, text: "Ran it." };
		}
		const runExactEvalMatch = /Run this exact code with the eval tool \(language (\w+)\):\s*([\s\S]+)$/.exec(text);
		if (runExactEvalMatch) {
			return {
				tool: "eval",
				args: { language: runExactEvalMatch[1], code: runExactEvalMatch[2]!.trim() },
				text: "Ran it.",
			};
		}
	}
	// Unrecognized prompt shape: reply plainly instead of hanging the turn.
	return { text: "OK." };
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Matches the pi-ai per-provider `streamSimple` signature exactly, but never
 * makes a network call — everything is decided in-process from `context`. */
function streamStressMock(
	model: Model<Api>,
	context: Context,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const decision = decide(context);
		const startedAt = Date.now();
		const blocks: Array<TextContent | ToolCall> = [];
		const partial: AssistantMessage = {
			role: "assistant",
			content: blocks,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: startedAt,
		};
		stream.push({ type: "start", partial });

		if (decision.tool) {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: `stress-mock-${Math.random().toString(36).slice(2)}`,
				name: decision.tool,
				arguments: decision.args ?? {},
			};
			blocks.push(toolCall);
			const contentIndex = blocks.length - 1;
			stream.push({ type: "toolcall_start", contentIndex, partial });
			stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial });
			stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
			partial.stopReason = "toolUse";
		} else {
			const block: TextContent = { type: "text", text: decision.text };
			blocks.push(block);
			const contentIndex = blocks.length - 1;
			stream.push({ type: "text_start", contentIndex, partial });
			stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
			stream.push({ type: "text_end", contentIndex, content: block.text, partial });
			partial.stopReason = "stop";
		}

		partial.duration = Date.now() - startedAt;
		stream.push({ type: "done", reason: partial.stopReason as "stop" | "toolUse", message: partial });
	})();
	return stream;
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("stress-mock", {
		baseUrl: "mock://stress-mock",
		apiKey: "unused",
		api: STRESS_MOCK_API,
		streamSimple: streamStressMock,
		models: [
			{
				id: "stress-mock",
				name: "Stress Mock (deterministic, zero-cost)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_000,
			},
		],
	});
}
