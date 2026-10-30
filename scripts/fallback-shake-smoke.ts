#!/usr/bin/env bun
/** Exercise a real omp process and HTTP provider, with no credentials or ambient extensions. */
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const binary = process.argv[2] ?? "omp";
const extension = process.argv[3] ?? path.join(os.homedir(), ".config/omp/fallback-shake/index.ts");
const requestSchema = type({
	model: "string",
	stream: "boolean",
	messages: type({ role: "string", "content?": "unknown", "tool_call_id?": "string" }).array(),
});
type RequestBody = typeof requestSchema.infer;
const requests: RequestBody[] = [];
const temp = TempDir.createSync("omp-fallback-shake-smoke-");
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (!new URL(request.url).pathname.endsWith("/chat/completions"))
			return new Response("not found", { status: 404 });
		const body = requestSchema.assert(await request.json());
		requests.push(body);
		if (body.model === "primary")
			return Response.json(
				{ error: { message: "overloaded_error: local smoke 503", type: "server_error" } },
				{ status: 503 },
			);
		assert.equal(body.model, "backup");
		const base = { id: "chatcmpl-fallback-smoke", object: "chat.completion.chunk", created: 0, model: "backup" };
		const chunks = [
			{
				...base,
				choices: [{ index: 0, delta: { role: "assistant", content: "fallback-smoke-ok" }, finish_reason: null }],
			},
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			{ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } },
		];
		return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	},
});

try {
	const agentDir = path.join(temp.path(), "agent");
	await Bun.write(
		path.join(agentDir, "models.yml"),
		Bun.YAML.stringify({
			providers: {
				fake: {
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					auth: "none",
					api: "openai-completions",
					models: ["primary", "backup"].map(id => ({
						id,
						name: id,
						reasoning: false,
						contextWindow: 128_000,
						maxTokens: 4096,
					})),
				},
			},
		}),
	);
	const settings = path.join(temp.path(), "settings.yml");
	await Bun.write(
		settings,
		Bun.YAML.stringify({
			modelRoles: { default: "fake/primary" },
			compaction: { enabled: false, dropUseless: false, supersedeReads: false },
			retry: {
				enabled: true,
				modelFallback: true,
				fallbackOn: "any",
				baseDelayMs: 1,
				fallbackChains: { "fake/primary": ["fake/backup"] },
			},
		}),
	);
	const manager = SessionManager.create(temp.path(), temp.path());
	const usage = {
		input: 20_000,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20_001,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (let i = 0; i < 8; i++) {
		manager.appendMessage({
			role: "user",
			content: `user-start-${i}\n\`\`\`text\n${"stable fenced content alpha beta gamma\n".repeat(160)}\`\`\``,
			timestamp: i * 4,
		});
		manager.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "fake",
			model: "primary",
			content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `/fixture/${i}` } }],
			usage,
			stopReason: "toolUse",
			timestamp: i * 4 + 1,
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: `call-${i}`,
			toolName: "read",
			content: [
				{ type: "text", text: `recover-original-${i}\n${"original tool output alpha beta gamma\n".repeat(160)}` },
			],
			useless: true,
			isError: false,
			timestamp: i * 4 + 2,
		});
		manager.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "fake",
			model: "primary",
			content: [{ type: "text", text: `answer-${i}` }],
			usage,
			stopReason: "stop",
			timestamp: i * 4 + 3,
		});
	}
	manager.appendMessage({
		role: "user",
		content: "agent budget steer, not a human exchange",
		attribution: "agent",
		steering: true,
		timestamp: 33,
	});
	manager.appendMessage({
		role: "user",
		content: "automatic continuation, not a human exchange",
		synthetic: true,
		timestamp: 34,
	});
	const protectedEntries = new Map(
		manager
			.getBranch()
			.slice(3 * 4)
			.map(entry => [entry.id, JSON.stringify(entry)]),
	);
	await manager.rewriteEntries();
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	await manager.close();
	const child = Bun.spawn(
		[
			binary,
			"--mode",
			"json",
			"--session",
			sessionFile,
			"--model",
			"fake/primary",
			"--thinking",
			"off",
			"--config",
			settings,
			"--trusted-extension",
			extension,
			"--no-tools",
			"--no-skills",
			"--no-rules",
			"-p",
			"continue as exchange nine",
		],
		{
			cwd: temp.path(),
			env: { ...process.env, HOME: temp.path(), PI_CODING_AGENT_DIR: agentDir, PI_CONFIG_DIR: ".omp" },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 45_000,
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	assert.equal(exitCode, 0, stderr || stdout);
	assert.ok(stdout.includes("fallback-smoke-ok"), stdout + stderr);
	const first = requests.find(request => request.model === "primary");
	const replacement = requests.find(request => request.model === "backup");
	assert.ok(first && replacement, JSON.stringify(requests.map(request => request.model)));
	const beforeTools = first.messages.filter(message => message.role === "tool");
	const afterTools = replacement.messages.filter(message => message.role === "tool");
	assert.equal(beforeTools.length, 8);
	assert.equal(afterTools.length, 8);
	assert.ok(JSON.stringify(afterTools[0]).includes("artifact://"));
	assert.ok(!JSON.stringify(afterTools[0]).includes("recover-original-0"));
	assert.deepEqual(afterTools.slice(3), beforeTools.slice(3));
	const beforeStart = first.messages.findIndex(
		message => message.role === "user" && JSON.stringify(message.content).includes("user-start-3"),
	);
	const afterStart = replacement.messages.findIndex(
		message => message.role === "user" && JSON.stringify(message.content).includes("user-start-3"),
	);
	assert.ok(beforeStart >= 0 && afterStart >= 0);
	assert.deepEqual(replacement.messages.slice(afterStart), first.messages.slice(beforeStart));
	const reopened = await SessionManager.open(sessionFile, temp.path());
	try {
		for (const [id, bytes] of protectedEntries)
			assert.equal(
				JSON.stringify(reopened.getBranch().find(entry => entry.id === id)),
				bytes,
				`Protected entry ${id} changed`,
			);
		const link = /artifact:\/\/([^\s)"\\]+)/.exec(JSON.stringify(afterTools[0]))?.[1];
		assert.ok(link);
		const artifact = await reopened.getArtifactPath(link);
		assert.ok(artifact);
		assert.ok((await Bun.file(artifact).text()).includes("recover-original-0"));
	} finally {
		await reopened.close();
	}
	console.log(
		JSON.stringify({
			result: "PASS",
			binary,
			extension,
			requests: requests.map(request => request.model),
			protectedSeededExchanges: 5,
			protectedNewestExchanges: 6,
			persistedEntriesUnchanged: protectedEntries.size,
			artifactRecovery: true,
		}),
	);
} finally {
	server.stop(true);
	await temp.remove();
}
