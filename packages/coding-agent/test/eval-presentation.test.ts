import { describe, expect, it } from "bun:test";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent";
import { EvalTool, evalOutcome } from "@oh-my-pi/pi-coding-agent/tools/eval";

/**
 * Eval presentation protocol acceptance tests.
 *
 * These tests verify the eval local execution route is migrated to the typed
 * presentation protocol: the adapter's selects/start contracts, sourceEcho
 * and rawInput carrying, and `evalOutcome`'s classification (the adapter's
 * own `outcome` hook is gone, producers attach `outcome` directly on the
 * result via `EvalTool#execute`'s wrapper around `evalOutcome`).
 * The proxy executor stays explicitly on legacy_snapshot.
 */

/** A minimal session stub that satisfies EvalTool's constructor and execute path. */
function mockSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		settings: new Map() as unknown as ToolSession["settings"],
		getActiveModel: () => undefined,
		allocateOutputArtifact: async () => undefined,
		getSessionFile: () => undefined,
		getEvalKernelOwnerId: () => undefined,
		getEvalSessionId: () => "test-session",
		getSessionSpawns: () => "*",
		assertEvalExecutionAllowed: () => {},
		trackEvalExecution: async (exec: Promise<unknown>) => exec,
		...overrides,
	} as unknown as ToolSession;
}

describe("eval presentation protocol acceptance", () => {
	it("the presentation adapter selects for local execution and not for proxy", () => {
		const localTool = new EvalTool(mockSession());
		const adapter = localTool.presentation;
		expect(adapter).toBeDefined();
		expect(adapter!.selects.call(localTool, {} as never)).toBe(true);

		const proxyTool = new EvalTool(mockSession(), {
			proxyExecutor: async () => ({ content: [{ type: "text", text: "" }], details: undefined }),
		});
		expect(proxyTool.presentation.selects.call(proxyTool, {} as never)).toBe(false);
	});

	it("start carries sourceEcho and rawInput with language and code", () => {
		const tool = new EvalTool(mockSession());
		const call = tool.presentation.start.call(tool, "call-1", {
			language: "py",
			title: "test cell",
			code: "print('hello')",
		} as never);
		expect(call.toolCallId).toBe("call-1");
		expect(call.toolName).toBe("eval");
		expect(call.title).toBe("test cell");
		expect(call.kind).toBe("execute");
		expect(call.sourceEcho).toBe("print('hello')");
		expect(call.rawInput).toEqual({ language: "py", code: "print('hello')" });
	});

	it("evalOutcome classifies success, nonzero exit, cancellation, and timeout structurally", () => {
		const successOutcome = evalOutcome({
			content: [{ type: "text", text: "ok" }],
			details: { cells: [{ index: 0, code: "", output: "ok", status: "complete", exitCode: 0 }] },
		} as never);
		expect(successOutcome.kind).toBe("succeeded");

		const failOutcome = evalOutcome({
			content: [{ type: "text", text: "err" }],
			details: { cells: [{ index: 0, code: "", output: "err", status: "error", exitCode: 1 }] },
			isError: true,
		} as never);
		expect(failOutcome.kind).toBe("failed");
		if (failOutcome.kind === "failed") {
			expect(failOutcome.failure.reason).toBe("process");
		}

		// Cancellation is carried structurally via the termination union, not
		// parsed from text.
		const cancelOutcome = evalOutcome({
			content: [{ type: "text", text: "Command aborted" }],
			details: {
				cells: [{ index: 0, code: "", output: "", status: "error" }],
				termination: { kind: "interrupted" },
			},
			isError: true,
		} as never);
		expect(cancelOutcome.kind).toBe("interrupted");

		// Timeout is a failure with the real timeoutMs, not a fabricated 0.
		const timeoutOutcome = evalOutcome({
			content: [{ type: "text", text: "Command timed out" }],
			details: {
				cells: [{ index: 0, code: "", output: "", status: "error" }],
				termination: { kind: "timed_out", timeoutMs: 30000 },
			},
			isError: true,
		} as never);
		expect(timeoutOutcome.kind).toBe("failed");
		if (timeoutOutcome.kind === "failed" && timeoutOutcome.process?.kind === "timed_out") {
			expect(timeoutOutcome.process.timeoutMs).toBe(30000);
		}

		// An error result with "[Command cancelled]" text but NO structural
		// `termination` field is a failure, not an interruption — output text
		// cannot change classification.
		const fakeCancelText = evalOutcome({
			content: [{ type: "text", text: "[Command cancelled]" }],
			details: {
				cells: [{ index: 0, code: "", output: "[Command cancelled]", status: "error" }],
			},
			isError: true,
		} as never);
		expect(fakeCancelText.kind).toBe("failed");
	});

	it("start with no title uses the tool label as fallback", () => {
		const tool = new EvalTool(mockSession());
		const call = tool.presentation.start.call(tool, "call-2", {
			language: "js",
			code: "1 + 1",
		} as never);
		expect(call.title).toBe("Eval");
		expect(call.sourceEcho).toBe("1 + 1");
	});

	it("start with no code omits sourceEcho and rawInput", () => {
		const tool = new EvalTool(mockSession());
		const call = tool.presentation.start.call(tool, "call-3", {
			language: "py",
			title: "no code",
		} as never);
		expect(call.sourceEcho).toBeUndefined();
		expect(call.rawInput).toBeUndefined();
	});
});
