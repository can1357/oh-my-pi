import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

// Exercise the existing real runRpcMode + AgentSession fixture, not RpcClient option forwarding.
async function start(script = "") {
	const directory = TempDir.createSync("@rpc-client-message-id-");
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "queued-message-rpc-agent.ts")], {
		cwd: directory.path(),
		env: { ...Bun.env, PI_CODING_AGENT_DIR: directory.path(), PI_NO_TITLE: "1", QUEUED_RPC_SCRIPT: script },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const frames: Record<string, unknown>[] = [];
	const listeners = new Set<() => void>();
	let failure: Error | undefined;
	const reading = (async () => {
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (isRecord(frame)) frames.push(frame);
				for (const listener of listeners) listener();
			}
			failure = new Error("RPC fixture closed stdout");
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		} finally {
			for (const listener of listeners) listener();
		}
	})();
	const stderr = new Response(child.stderr).text();
	cleanup.push(async () => {
		child.kill();
		await child.exited;
		await reading;
		await stderr;
		directory.removeSync();
	});
	async function next(match: (frame: Record<string, unknown>) => boolean) {
		const result = Promise.withResolvers<Record<string, unknown>>();
		const check = () => {
			const found = frames.find(match);
			if (found) result.resolve(found);
			else if (failure) result.reject(failure);
		};
		listeners.add(check);
		check();
		try {
			return await withTimeout(result.promise, 5_000, "Missing RPC correlation frame");
		} finally {
			listeners.delete(check);
		}
	}
	let sequence = 0;
	async function command(type: string, fields: Record<string, unknown> = {}) {
		const id = `request-${++sequence}`;
		child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		await child.stdin.flush();
		return next(frame => frame.type === "response" && frame.id === id);
	}
	/** Write several frames in one stdin chunk, so all are accepted before any handler runs. */
	async function pipeline(...requests: [type: string, fields?: Record<string, unknown>][]) {
		const ids = requests.map(() => `request-${++sequence}`);
		child.stdin.write(
			requests.map(([type, fields], index) => `${JSON.stringify({ id: ids[index], type, ...fields })}\n`).join(""),
		);
		await child.stdin.flush();
		return Promise.all(ids.map(id => next(frame => frame.type === "response" && frame.id === id)));
	}
	await next(frame => frame.type === "ready");
	return { command, pipeline, next, frames };
}

function data(frame: Record<string, unknown>): Record<string, unknown> {
	expect(frame.success).toBe(true);
	expect(isRecord(frame.data)).toBe(true);
	return frame.data as Record<string, unknown>;
}

describe("RPC client message identity", () => {
	test("advertises support before accepting correlation and preserves an uncorrelated legacy queue slot", async () => {
		const rpc = await start();
		expect(data(await rpc.command("get_state"))).toMatchObject({ supportsClientMessageIds: true });
		await rpc.command("follow_up", { message: "legacy" });
		const response = await rpc.command("follow_up", { message: "correlated", clientMessageId: "x".repeat(128) });
		expect(response.success).toBe(true);
		expect(data(await rpc.command("get_state"))).toMatchObject({
			queuedMessages: {
				followUp: ["legacy", "correlated"],
				clientMessageIds: { steering: [], followUp: [null, "x".repeat(128)] },
			},
		});
	});

	test("rejects invalid correlation before admission or abort side effects on every input command", async () => {
		const rpc = await start("hold");
		await rpc.command("prompt", { message: "keep streaming", clientMessageId: "intent-running" });
		await rpc.next(frame => frame.type === "message_end" && frame.clientMessageId === "intent-running");
		// Distinct trust-boundary failures; abort_and_prompt must validate BEFORE aborting.
		for (const [type, clientMessageId] of [
			["prompt", ""],
			["steer", 42],
			["follow_up", "x".repeat(129)],
			["abort_and_prompt", null],
		] as const) {
			const response = await rpc.command(type, { message: "must not be admitted", clientMessageId });
			expect(response).toMatchObject({ success: false, command: type });
		}
		expect(data(await rpc.command("get_state"))).toMatchObject({ isStreaming: true, queuedMessageCount: 0 });
		expect(
			rpc.frames.filter(
				frame => frame.type === "message_start" && isRecord(frame.message) && frame.message.role === "user",
			),
		).toHaveLength(1);
	});

	test("selectively reconciles a streaming prompt and duplicate queued IDs without draining or starting a turn", async () => {
		const rpc = await start("hold");
		await rpc.command("prompt", { message: "long request", clientMessageId: "intent-active" });
		await rpc.next(frame => frame.type === "message_end" && frame.clientMessageId === "intent-active");
		await rpc.command("steer", { message: "duplicate", clientMessageId: "intent-steer" });
		await rpc.command("prompt", {
			message: "duplicate",
			streamingBehavior: "followUp",
			clientMessageId: "intent-follow",
		});
		const before = data(await rpc.command("get_state"));
		const found = data(
			await rpc.command("get_client_message_status", {
				clientMessageIds: ["intent-active", "intent-follow", "missing"],
			}),
		);
		expect(found).toMatchObject({
			messages: [
				{
					clientMessageId: "intent-active",
					message: { role: "user", content: [{ type: "text", text: "long request" }] },
				},
			],
			queuedMessages: {
				steering: ["duplicate"],
				followUp: ["duplicate"],
				clientMessageIds: { steering: ["intent-steer"], followUp: ["intent-follow"] },
			},
			resolvedClientMessageIds: [],
			unresolvedClientMessageIds: ["missing"],
		});
		const after = data(await rpc.command("get_state"));
		expect(after).toMatchObject({
			isStreaming: true,
			messageCount: before.messageCount,
			queuedMessages: before.queuedMessages,
		});
		expect(rpc.frames.filter(frame => frame.type === "agent_start")).toHaveLength(1);
		expect(rpc.frames).toContainEqual(
			expect.objectContaining({ type: "message_end", clientMessageId: "intent-active" }),
		);
	});

	test("reports abort-and-restore as explicit resolutions, not inferred absence", async () => {
		const rpc = await start("hold");
		await rpc.command("prompt", { message: "running", clientMessageId: "intent-not-withdrawn" });
		await rpc.next(frame => frame.type === "message_end" && frame.clientMessageId === "intent-not-withdrawn");
		await rpc.command("steer", { message: "restore this", clientMessageId: "intent-restore" });
		await rpc.command("follow_up", { message: "restore follow-up", clientMessageId: "intent-restore-follow" });
		expect((await rpc.command("abort_and_restore_queue")).success).toBe(true);
		const found = data(
			await rpc.command("get_client_message_status", {
				clientMessageIds: ["intent-restore", "intent-restore-follow", "intent-not-withdrawn", "absent"],
			}),
		);
		expect(found.resolvedClientMessageIds).toEqual(["intent-restore", "intent-restore-follow"]);
		expect(found.unresolvedClientMessageIds).toEqual(["absent"]);
		expect(found.messages).toMatchObject([{ clientMessageId: "intent-not-withdrawn", message: { role: "user" } }]);
	});

	test("correlates abort_and_prompt's replacement independently of the interrupted intent", async () => {
		const rpc = await start("hold");
		await rpc.command("prompt", { message: "first", clientMessageId: "intent-interrupted" });
		await rpc.next(frame => frame.type === "message_end" && frame.clientMessageId === "intent-interrupted");
		expect(
			(await rpc.command("abort_and_prompt", { message: "replacement", clientMessageId: "intent-replacement" }))
				.success,
		).toBe(true);
		await rpc.next(frame => frame.type === "message_end" && frame.clientMessageId === "intent-replacement");
		const found = data(
			await rpc.command("get_client_message_status", {
				clientMessageIds: ["intent-interrupted", "intent-replacement"],
			}),
		);
		expect(found.messages).toMatchObject([
			{ clientMessageId: "intent-interrupted", message: { content: [{ type: "text", text: "first" }] } },
			{ clientMessageId: "intent-replacement", message: { content: [{ type: "text", text: "replacement" }] } },
		]);
		expect(found.resolvedClientMessageIds).toEqual([]);
	});

	test("resolves a locally consumed builtin without fabricating a native message or turn", async () => {
		const rpc = await start();
		expect((await rpc.command("prompt", { message: "/session info", clientMessageId: "intent-local" })).success).toBe(
			true,
		);
		const found = data(
			await rpc.command("get_client_message_status", { clientMessageIds: ["intent-local", "never-written"] }),
		);
		expect(found).toMatchObject({
			messages: [],
			persistedClientMessageIds: [],
			resolvedClientMessageIds: ["intent-local"],
			unresolvedClientMessageIds: ["never-written"],
		});
		expect(rpc.frames.some(frame => frame.type === "command_output")).toBe(true);
		expect(rpc.frames.some(frame => frame.type === "agent_start" || frame.type === "message_start")).toBe(false);
	});

	test("rejects a reused ID before abort_and_prompt interrupts its already accepted turn", async () => {
		const rpc = await start("hold");
		await rpc.command("prompt", { message: "keep running", clientMessageId: "intent-once" });
		await rpc.next(frame => frame.type === "message_end" && frame.clientMessageId === "intent-once");
		expect(
			await rpc.command("abort_and_prompt", { message: "different input", clientMessageId: "intent-once" }),
		).toMatchObject({
			success: false,
			command: "abort_and_prompt",
		});
		expect(data(await rpc.command("get_state"))).toMatchObject({ isStreaming: true, queuedMessageCount: 0 });
		expect(rpc.frames.filter(frame => frame.type === "agent_start")).toHaveLength(1);
	});

	test("bounds status requests and rejects malformed selectors without altering state", async () => {
		const rpc = await start();
		const ids = Array.from({ length: 32 }, (_, i) => `unknown-${i}`);
		const maximum = data(await rpc.command("get_client_message_status", { clientMessageIds: ids }));
		expect(maximum).toMatchObject({
			messages: [],
			resolvedClientMessageIds: [],
			persistedClientMessageIds: [],
			unresolvedClientMessageIds: ids,
		});
		for (const clientMessageIds of [
			[],
			[...ids, "overflow"],
			["duplicate", "duplicate"],
			[""],
			["x".repeat(129)],
			[17],
			"not-an-array",
		]) {
			expect(await rpc.command("get_client_message_status", { clientMessageIds })).toMatchObject({
				command: "get_client_message_status",
				success: false,
			});
		}
		expect(data(await rpc.command("get_state"))).toMatchObject({
			isStreaming: false,
			messageCount: 0,
			queuedMessageCount: 0,
		});
	});

	test("omits a message that would overflow the v1 response limit instead of failing reconciliation", async () => {
		const rpc = await start();
		// Each prompt fits a v1 input frame; together they exceed the 1 MiB v1 response limit.
		const first = `${"a".repeat(700 * 1024)}first`;
		await rpc.command("prompt", { message: first, clientMessageId: "intent-large-a" });
		await rpc.next(frame => frame.type === "agent_end");
		await rpc.command("prompt", { message: `${"b".repeat(700 * 1024)}second`, clientMessageId: "intent-large-b" });
		await rpc.next(frame => frame.type === "message_end" && frame.clientMessageId === "intent-large-b");
		const response = await rpc.command("get_client_message_status", {
			clientMessageIds: ["intent-large-a", "intent-large-b"],
		});
		expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThan(1024 * 1024);
		expect(data(response)).toMatchObject({
			messages: [{ clientMessageId: "intent-large-a", message: { content: [{ type: "text", text: first }] } }],
			persistedClientMessageIds: ["intent-large-a", "intent-large-b"],
			unresolvedClientMessageIds: [],
		});
	});

	test("rejects an abort_and_prompt reusing a pending prompt's ID instead of superseding it", async () => {
		const rpc = await start("hold");
		const [original, duplicate] = await rpc.pipeline(
			["prompt", { message: "original", clientMessageId: "intent-pending" }],
			["abort_and_prompt", { message: "replacement", clientMessageId: "intent-pending" }],
		);
		expect(original).toMatchObject({ success: true });
		expect(duplicate).toMatchObject({ success: false, command: "abort_and_prompt" });
		await rpc.next(frame => frame.type === "message_end" && frame.clientMessageId === "intent-pending");
		const found = data(await rpc.command("get_client_message_status", { clientMessageIds: ["intent-pending"] }));
		expect(found.messages).toMatchObject([{ message: { content: [{ type: "text", text: "original" }] } }]);
		expect(data(await rpc.command("get_state"))).toMatchObject({ isStreaming: true });
	});

	test("checks a prompt pipelined behind new_session against the new session, not the old one", async () => {
		const rpc = await start();
		await rpc.command("prompt", { message: "old session", clientMessageId: "intent-per-session" });
		await rpc.next(frame => frame.type === "agent_end");
		const [switched, prompted] = await rpc.pipeline(
			["new_session"],
			["prompt", { message: "new session", clientMessageId: "intent-per-session" }],
		);
		expect(switched).toMatchObject({ success: true });
		expect(prompted).toMatchObject({ success: true });
		await rpc.next(
			frame =>
				frame.type === "message_end" &&
				frame.clientMessageId === "intent-per-session" &&
				isRecord(frame.message) &&
				JSON.stringify(frame.message.content).includes("new session"),
		);
		const found = data(await rpc.command("get_client_message_status", { clientMessageIds: ["intent-per-session"] }));
		expect(found.messages).toMatchObject([{ message: { content: [{ type: "text", text: "new session" }] } }]);
	});
});
