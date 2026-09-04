import { afterAll, describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

interface FakeCall {
	id: string;
	args: unknown;
	signal?: AbortSignal;
}

function makeFakeTool(name: string, calls: FakeCall[], result: AgentToolResult): AgentTool {
	const tool = {
		name,
		label: name,
		description: name,
		parameters: { type: "object" },
		async execute(id: string, args: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
			calls.push({ id, args, signal });
			return result;
		},
	} as unknown as AgentTool;
	return tool;
}

function makeSession(tools: Map<string, AgentTool>): ToolSession {
	return { getToolByName: (name: string) => tools.get(name) } as unknown as ToolSession;
}

async function call(
	info: { url: string; token: string },
	body: Record<string, unknown>,
	overrides?: { token?: string },
): Promise<Response> {
	return await fetch(`${info.url}/v1/tool`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${overrides?.token ?? info.token}`,
		},
		body: JSON.stringify(body),
	});
}

describe("Python tool bridge HTTP server", () => {
	afterAll(async () => {
		await disposePyToolBridge();
	});

	it("dispatches calls to the registered ToolSession and returns the tool value", async () => {
		const calls: FakeCall[] = [];
		const readTool = makeFakeTool("read", calls, {
			content: [{ type: "text", text: "file body" }],
		});
		const session = makeSession(new Map([["read", readTool]]));
		const info = await ensurePyToolBridge();
		const unregister = registerPyToolBridge("test-session-1", "run-1", { toolSession: session });
		try {
			const res = await call(info, {
				session: "test-session-1",
				run: "run-1",
				name: "read",
				args: { path: "foo.ts", [INTENT_FIELD]: "py prelude" },
			});
			const body = await res.json();
			expect(res.status).toBe(200);
			expect(body).toEqual({ ok: true, value: "file body" });
			expect(calls).toHaveLength(1);
			// `i` survives the bridge round trip so transcript renderers have a label.
			expect((calls[0]!.args as Record<string, unknown>)[INTENT_FIELD]).toBe("py prelude");
		} finally {
			unregister();
		}
	});

	it("returns ok=false when no session is registered for the given id", async () => {
		const info = await ensurePyToolBridge();
		const res = await call(info, { session: "missing", run: "run-missing", name: "read", args: {} });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; error?: string };
		expect(body.ok).toBe(false);
		expect(typeof body.error).toBe("string");
	});

	it("surfaces tool errors as ok=false with the error message", async () => {
		const session = {
			getToolByName: () =>
				({
					name: "boom",
					label: "boom",
					description: "boom",
					parameters: { type: "object" },
					async execute(): Promise<AgentToolResult> {
						throw new Error("kapow");
					},
				}) as unknown as AgentTool,
		} as unknown as ToolSession;
		const info = await ensurePyToolBridge();
		const unregister = registerPyToolBridge("err-session", "run-err", { toolSession: session });
		try {
			const res = await call(info, { session: "err-session", run: "run-err", name: "boom", args: {} });
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual({ ok: false, error: "kapow" });
		} finally {
			unregister();
		}
	});

	it("rejects requests with a bad bearer token", async () => {
		const info = await ensurePyToolBridge();
		const res = await call(
			info,
			{ session: "anything", run: "run-anything", name: "read", args: {} },
			{ token: "wrong" },
		);
		expect(res.status).toBe(403);
	});

	it("returns 400 when body is missing required fields", async () => {
		const info = await ensurePyToolBridge();
		const res = await call(info, { name: "read" });
		expect(res.status).toBe(400);
	});

	it("invokes emitStatus alongside the tool result", async () => {
		const calls: FakeCall[] = [];
		const readTool = makeFakeTool("read", calls, {
			content: [{ type: "text", text: "abc" }],
		});
		const session = makeSession(new Map([["read", readTool]]));
		const info = await ensurePyToolBridge();
		const statusEvents: Array<{ op: string }> = [];
		const unregister = registerPyToolBridge("status-session", "run-status", {
			toolSession: session,
			emitStatus: event => statusEvents.push(event),
		});
		try {
			const res = await call(info, {
				session: "status-session",
				run: "run-status",
				name: "read",
				args: { path: "foo.ts" },
			});
			expect(res.status).toBe(200);
			expect(statusEvents).toHaveLength(1);
			expect(statusEvents[0]!.op).toBe("read");
		} finally {
			unregister();
		}
	});

	it("force-stops with an in-flight response without an unhandled socket rejection", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tool = {
			name: "slow",
			label: "slow",
			description: "slow",
			parameters: { type: "object" },
			async execute(): Promise<AgentToolResult> {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "done" }] };
			},
		} as unknown as AgentTool;
		const session = makeSession(new Map([["slow", tool]]));
		const info = await ensurePyToolBridge();
		const unregister = registerPyToolBridge("shutdown-session", "run-shutdown", { toolSession: session });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const response = call(info, {
				session: "shutdown-session",
				run: "run-shutdown",
				name: "slow",
				args: {},
			}).then(
				res => res.text(),
				() => undefined,
			);
			await started.promise;
			const stopping = disposePyToolBridge();
			await Promise.resolve();
			release.resolve();
			await stopping;
			await response;
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(unhandled).toEqual([]);
		} finally {
			release.resolve();
			unregister();
			process.off("unhandledRejection", onUnhandled);
			await disposePyToolBridge();
		}
	});
});
