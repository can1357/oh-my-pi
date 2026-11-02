import { describe, expect, test } from "bun:test";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

interface Request {
	id: string;
	type: string;
	captureId?: string;
}

function fakeAgent() {
	const exited = Promise.withResolvers<number>();
	const requests: Request[] = [];
	const encoder = new TextEncoder();
	let output!: ReadableStreamDefaultController<Uint8Array>;
	const proc: RpcAgentProcess = {
		stdin: {
			write(data) {
				requests.push(JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Request);
				return 0;
			},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				output = controller;
				controller.enqueue(encoder.encode('{"type":"ready"}\n'));
			},
		}),
		peekStderr: () => "",
		kill: () => exited.resolve(0),
		exited: exited.promise,
	};
	return {
		proc,
		requests,
		emit(frame: unknown) {
			output.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
		},
		reply(request: Request, data?: unknown) {
			output.enqueue(
				encoder.encode(
					`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data })}\n`,
				),
			);
		},
	};
}

// Only scale timers while issuing a request; restore the global before awaiting anything.
function withScaledDeadline<T>(send: () => T): T {
	const original = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void, delay?: number) =>
		original(callback, (delay ?? 0) / 300)) as typeof setTimeout;
	try {
		return send();
	} finally {
		globalThis.setTimeout = original;
	}
}

describe("RpcClient dictation start deadlines", () => {
	test("cold start can finish after an ordinary request has timed out", async () => {
		const agent = fakeAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();

		let startSettled = false;
		const start = withScaledDeadline(() => client.dictationStart("cold-model"));
		void start.then(
			() => {
				startSettled = true;
			},
			() => {
				startSettled = true;
			},
		);
		const ordinary = withScaledDeadline(() => client.getState());
		await expect(ordinary).rejects.toThrow("Timeout waiting for response to get_state");
		expect(startSettled).toBe(false);
		expect(agent.requests[0]).toMatchObject({ type: "dictation_start", captureId: "cold-model" });
		agent.reply(agent.requests[0]);
		await expect(start).resolves.toBeUndefined();
	});

	test("caller deadline rejects explicitly and can be followed by a stop", async () => {
		const agent = fakeAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();

		const start = withScaledDeadline(() => client.dictationStart("short-deadline", 6_000));
		await expect(start).rejects.toThrow("Timeout waiting for response to dictation_start");
		expect(agent.requests[0]).toMatchObject({ type: "dictation_start", captureId: "short-deadline" });
		const stop = client.dictationStop();
		expect(agent.requests[1].type).toBe("dictation_stop");
		agent.reply(agent.requests[1], { text: "" });
		await expect(stop).resolves.toEqual({ text: "" });
	});
});

describe("RpcClient dictation stop deadlines", () => {
	test("slow flush can finish after an ordinary request has timed out", async () => {
		const agent = fakeAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();

		let stopSettled = false;
		const stop = withScaledDeadline(() => client.dictationStop());
		void stop.then(
			() => {
				stopSettled = true;
			},
			() => {
				stopSettled = true;
			},
		);
		const ordinary = withScaledDeadline(() => client.getState());
		await expect(ordinary).rejects.toThrow("Timeout waiting for response to get_state");
		expect(stopSettled).toBe(false);
		expect(agent.requests[0].type).toBe("dictation_stop");
		agent.reply(agent.requests[0], { text: "completed draft" });
		await expect(stop).resolves.toEqual({ text: "completed draft" });
	});

	test("caller timeout rejects without losing the later terminal transcript", async () => {
		const agent = fakeAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();
		const terminal = Promise.withResolvers<string>();
		client.onDictation(frame => {
			if (frame.type === "dictation_end") terminal.resolve(frame.text);
		});

		const stop = withScaledDeadline(() => client.dictationStop(6_000));
		await expect(stop).rejects.toThrow("Timeout waiting for response to dictation_stop");
		agent.emit({ type: "dictation_end", captureId: "slow-flush", text: "completed draft" });
		agent.reply(agent.requests[0], { text: "completed draft" });
		await expect(terminal.promise).resolves.toBe("completed draft");
	});
});
