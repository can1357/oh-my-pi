/**
 * Scripted OpenAI-compatible chat completions server for the RPC client smoke
 * tests (Rust, Go): lets a real `omp --mode rpc` run full prompt turns, host
 * tool calls included, without a real model.
 *
 * `bun test/rpc-wire/fake-openai-server.ts <agentDir>` listens on a free
 * loopback port, writes `<agentDir>/models.yml` declaring provider `fake`
 * (model `fake-model`, no auth) at that port, prints `READY <port>`, and serves
 * until stdin closes. Start omp with `PI_CODING_AGENT_DIR=<agentDir>` and
 * `--model fake/fake-model`.
 *
 * Replies, by the conversation's last message:
 * - a tool result → text `tool said: <result text>`
 * - a user message containing `echo_host` → a call to the `echo_host` tool with
 *   `{"message": "hello"}` (through `write` to `xd://echo_host` when host tools
 *   are mounted as devices)
 * - a user message containing `read_uri <url>` → a `read` call for `<url>`
 * - a user message containing `write_uri <url>` → a `write` call storing
 *   `written by model` at `<url>`
 * - anything else → text `pong`
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";

const chatRequestSchema = type({
	"messages?": type({ role: "string", "content?": "unknown" }).array(),
	"tools?": type({ "function?": { "name?": "string" } }).array(),
	"stream?": "boolean",
});

type ChatRequest = typeof chatRequestSchema.infer;

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

function scriptedReply(request: ChatRequest): Reply {
	const messages = request.messages ?? [];
	const last = messages.at(-1);
	if (last?.role === "tool") return { text: `tool said: ${messageText(last.content)}` };
	const offered = new Set((request.tools ?? []).map(tool => tool.function?.name));
	const userText = last?.role === "user" ? messageText(last.content) : "";
	const uriRequest = /\b(read|write)_uri (\S+)/.exec(userText);
	if (uriRequest?.[1] === "read") return { tool: "read", args: { path: uriRequest[2] } };
	if (uriRequest?.[1] === "write") {
		return { tool: "write", args: { path: uriRequest[2], content: "written by model" } };
	}
	if (userText.includes("echo_host")) {
		const args = { message: "hello" };
		if (offered.has("echo_host")) return { tool: "echo_host", args };
		if (offered.has("write"))
			return { tool: "write", args: { path: "xd://echo_host", content: JSON.stringify(args) } };
	}
	return { text: "pong" };
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function completionChunks(reply: Reply): object[] {
	const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
	const delta =
		"text" in reply
			? { role: "assistant", content: reply.text }
			: {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `call_${reply.tool}`,
							type: "function",
							function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
						},
					],
				};
	const finish = "text" in reply ? "stop" : "tool_calls";
	return [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
		{ ...base, choices: [], usage: USAGE },
	];
}

function completionBody(reply: Reply): object {
	const message =
		"text" in reply
			? { role: "assistant", content: reply.text }
			: {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: `call_${reply.tool}`,
							type: "function",
							function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
						},
					],
				};
	return {
		id: "chatcmpl-fake",
		object: "chat.completion",
		created: 0,
		model: "fake-model",
		choices: [{ index: 0, message, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
		usage: USAGE,
	};
}

const agentDir = process.argv[2];
if (!agentDir) throw new Error("usage: fake-openai-server.ts <agentDir>");

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
		}
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const body = chatRequestSchema.assert(await request.json());
		const reply = scriptedReply(body);
		if (!body.stream) return Response.json(completionBody(reply));
		const events = completionChunks(reply).map(chunk => `data: ${JSON.stringify(chunk)}\n\n`);
		return new Response(`${events.join("")}data: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	},
});

await Bun.write(
	path.join(agentDir, "models.yml"),
	[
		"providers:",
		"  fake:",
		`    baseUrl: http://127.0.0.1:${server.port}/v1`,
		"    auth: none",
		"    api: openai-completions",
		"    models:",
		"      - id: fake-model",
		"        name: Fake Model",
		"        reasoning: false",
		"",
	].join("\n"),
);
console.log(`READY ${server.port}`);

for await (const _ of Bun.stdin.stream()) {
	// Serve until the parent closes stdin.
}
server.stop(true);
