import { afterAll, describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { PYTHON_PRELUDE } from "@oh-my-pi/pi-coding-agent/eval/py/prelude";
import {
	disposePyToolBridge,
	ensurePyToolBridge,
	registerPyToolBridge,
} from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import type { EvalShadowCellSession } from "@oh-my-pi/pi-coding-agent/eval/speculation/cell-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { $which, isRecord } from "@oh-my-pi/pi-utils";
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
				args: { path: "foo.ts" },
			});
			const body = await res.json();
			expect(res.status).toBe(200);
			expect(body).toEqual({ ok: true, value: "file body" });
			expect(calls).toHaveLength(1);
			expect(calls[0]!.args).toEqual({ path: "foo.ts", [INTENT_FIELD]: "py prelude" });
		} finally {
			unregister();
		}
	});

	it("preserves explicit caller intent for tools whose schema does not declare it", async () => {
		const calls: FakeCall[] = [];
		const tool = makeFakeTool("inspect", calls, {
			content: [{ type: "text", text: "done" }],
		});
		const session = makeSession(new Map([["inspect", tool]]));
		const info = await ensurePyToolBridge();
		const unregister = registerPyToolBridge("explicit-intent-session", "explicit-intent-run", {
			toolSession: session,
		});
		try {
			const res = await call(info, {
				session: "explicit-intent-session",
				run: "explicit-intent-run",
				name: "inspect",
				args: { target: "value", [INTENT_FIELD]: "caller supplied" },
			});
			expect(await res.json()).toEqual({ ok: true, value: "done" });
			expect(calls[0]!.args).toEqual({ target: "value", [INTENT_FIELD]: "caller supplied" });
		} finally {
			unregister();
		}
	});
	it("keeps Python defaults out of schema-owned intent parameters", async () => {
		let executions = 0;
		const constrained = {
			name: "constrained",
			label: "constrained",
			description: "Reports the validated tool-owned parameter",
			parameters: {
				type: "object",
				properties: { i: { type: "string", enum: ["allowed"] } },
				additionalProperties: false,
			},
			async execute(_id: string, args: unknown): Promise<AgentToolResult> {
				executions++;
				if (!isRecord(args)) throw new Error("Expected object arguments");
				return { content: [{ type: "text", text: String(args.i ?? "omitted") }] };
			},
		} as unknown as AgentTool;
		const info = await ensurePyToolBridge();
		const sessionId = `python-intent-${crypto.randomUUID()}`;
		const unregister = registerPyToolBridge(sessionId, "run", {
			toolSession: makeSession(new Map([["constrained", constrained]])),
		});
		try {
			const prelude = PYTHON_PRELUDE.replace(
				"from __future__ import annotations",
				"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
			);
			const script = `${prelude}
__omp_run_id__ = "run"
async def check_intent():
    print(await tool.constrained())
    print(await tool.constrained(i=None))
    print(await tool.constrained(i="allowed"))
    try:
        await tool.constrained(i="py prelude")
    except RuntimeError:
        print("invalid rejected")
    else:
        raise AssertionError("Invalid tool-owned intent reached execution")
asyncio.run(check_intent())
`;
			// Feed the script over stdin: the inlined prelude exceeds Windows spawn limits via `-c`.
			const child = Bun.spawn([Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python"), "-"], {
				stdin: new Response(script),
				stdout: "pipe",
				stderr: "pipe",
				signal: AbortSignal.timeout(10_000),
				env: {
					...process.env,
					PI_TOOL_BRIDGE_URL: info.url,
					PI_TOOL_BRIDGE_TOKEN: info.token,
					PI_TOOL_BRIDGE_SESSION: sessionId,
				},
			});
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect({ exitCode, stdout: stdout.replaceAll("\r\n", "\n"), stderr }).toEqual({
					exitCode: 0,
					stdout: "omitted\nomitted\nallowed\ninvalid rejected\n",
					stderr: "",
				});
				expect(executions).toBe(3);
			} finally {
				child.kill();
				await child.exited;
			}
		} finally {
			unregister();
		}
	}, 15_000);

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

	it("settles an interrupted speculative wait without starting ordinary tool execution", async () => {
		const calls: FakeCall[] = [];
		const started = Promise.withResolvers<void>();
		const controller = new AbortController();
		const lateClaim = Promise.withResolvers<undefined>();
		let claimSignal: AbortSignal | undefined;
		const shadowCell = {
			async claim(
				_name: string,
				_args: unknown,
				_identity: { siteId: string; occurrence: number },
				_remainingTimeoutMs: number,
				signal?: AbortSignal,
			) {
				claimSignal = signal;
				started.resolve();
				return await lateClaim.promise;
			},
		} as unknown as EvalShadowCellSession;
		const info = await ensurePyToolBridge();
		const sessionId = `claim-abort-${crypto.randomUUID()}`;
		const unregister = registerPyToolBridge(sessionId, "run", {
			toolSession: makeSession(new Map([["read", makeFakeTool("read", calls, { content: [] })]])),
			signal: controller.signal,
			shadowCell,
		});
		try {
			const response = call(info, {
				session: sessionId,
				run: "run",
				name: "read",
				args: { path: "waiting.txt" },
				identity: { siteId: "site-1", occurrence: 0 },
			});
			await started.promise;
			controller.abort();

			expect(await (await response).json()).toEqual({
				ok: false,
				error: 'bridge call "read" aborted: eval cell was interrupted',
			});
			expect(claimSignal).toBe(controller.signal);
			expect(calls).toEqual([]);
			lateClaim.reject(new Error("late speculative failure"));
			await Promise.resolve();
		} finally {
			unregister();
		}
	});

	it("carries call-site identity through an awaited read", async () => {
		const calls: FakeCall[] = [];
		const readTool = makeFakeTool("read", calls, {
			content: [{ type: "text", text: "file body" }],
		});
		const claims: Array<{ name: string; args: unknown; identity: { siteId: string; occurrence: number } }> = [];
		const shadowCell = {
			async claim(name: string, args: unknown, identity: { siteId: string; occurrence: number }) {
				claims.push({ name, args, identity });
				return undefined;
			},
		} as unknown as EvalShadowCellSession;
		const info = await ensurePyToolBridge();
		const sessionId = `py-identity-${crypto.randomUUID()}`;
		const unregister = registerPyToolBridge(sessionId, "run", {
			toolSession: makeSession(new Map([["read", readTool]])),
			shadowCell,
		});
		try {
			const prelude = PYTHON_PRELUDE.replace(
				"from __future__ import annotations",
				"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
			);
			// Mirror the runner rewrite shape: `await tool.read({...})` becomes
			// `await __omp_with_call_site__(siteId, tool.read, {...})`.
			const script = `${prelude}
__omp_run_id__ = "run"
async def check_identity():
    print(await __omp_with_call_site__("py:0", tool.read, {"path": "foo.txt"}))
    print(await __omp_with_call_site__("py:0", tool.read, {"path": "foo.txt"}))
asyncio.run(check_identity())
`;
			const child = Bun.spawn([Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python"), "-"], {
				stdin: new Response(script),
				stdout: "pipe",
				stderr: "pipe",
				signal: AbortSignal.timeout(10_000),
				env: {
					...process.env,
					PI_TOOL_BRIDGE_URL: info.url,
					PI_TOOL_BRIDGE_TOKEN: info.token,
					PI_TOOL_BRIDGE_SESSION: sessionId,
				},
			});
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect({ exitCode, stdout: stdout.replaceAll("\r\n", "\n"), stderr }).toEqual({
					exitCode: 0,
					stdout: "file body\nfile body\n",
					stderr: "",
				});
				expect(claims).toEqual([
					{ name: "read", args: { path: "foo.txt" }, identity: { siteId: "py:0", occurrence: 0 } },
					{ name: "read", args: { path: "foo.txt" }, identity: { siteId: "py:0", occurrence: 1 } },
				]);
				expect(calls).toHaveLength(2);
			} finally {
				child.kill();
				await child.exited;
			}
		} finally {
			unregister();
		}
	}, 15_000);

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
