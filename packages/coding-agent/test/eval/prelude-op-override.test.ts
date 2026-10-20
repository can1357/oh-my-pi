import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";

/**
 * Regression for #16446: `workpool()` and `judgeBatch()` spread the caller's
 * options object AFTER their own `op: "create"`, so a caller-supplied `op`
 * overrode the helper's own operation. The bridge then ran that operation
 * against the caller's live pool/batch (e.g. `close`) instead of creating a
 * new one, and the helper threw "did not return a pool".
 *
 * The prelude source is executed verbatim in a throwaway VM context with only
 * the host bridge (`__omp_call_tool__`) stubbed, so the test runs against the
 * real shipped helper. The stub mirrors the host bridges' op dispatch: only
 * `op: "create"` creates, every other op addresses an existing pool/batch.
 */
function loadPrelude(
	callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Record<string, unknown> {
	const sandbox: Record<string, unknown> = { __omp_call_tool__: callTool };
	vm.createContext(sandbox);
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
	return sandbox;
}

interface BridgeCall {
	name: string;
	args: Record<string, unknown>;
}

type WorkpoolHelper = (agent?: string, options?: unknown) => Promise<unknown>;
type JudgeBatchHelper = (states: unknown, questions: unknown, options?: unknown) => Promise<unknown>;

describe("eval js workpool() op precedence (issue #16446)", () => {
	it("creates a new pool even when the caller passes an op in the options object", async () => {
		const calls: BridgeCall[] = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			if (args.op === "create") {
				return {
					name: typeof args.name === "string" ? args.name : "worker-pool",
					agent: "worker",
					limit: 2,
				};
			}
			// Every other op addresses an already existing pool on the host.
			if (args.op === "close") return { dropped: [] };
			if (args.op === "push") return { ids: [] };
			return {};
		});
		const workpool = sandbox.workpool as WorkpoolHelper;

		const pool = await workpool("worker", { op: "close", name: "live-pool" });

		expect(pool).toMatchObject({ name: "live-pool" });
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("__workpool__");
		expect(calls[0].args.op).toBe("create");
	});
});

describe("eval js judgeBatch() op precedence (issue #16446)", () => {
	it("creates a new batch even when the caller passes an op in the options object", async () => {
		const calls: BridgeCall[] = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			if (args.op === "create") return { id: "batch-1", total: 1, intent: "Judging" };
			// Non-create ops need an existing batch id, exactly like the host bridge.
			throw new Error("op requires a batch id");
		});
		const judgeBatch = sandbox.judgeBatch as JudgeBatchHelper;

		const batch = await judgeBatch({ first: { ok: true } }, { q1: { instructions: "check" } }, { op: "close" });

		expect(batch).toMatchObject({ id: "batch-1" });
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("__judge_batch__");
		expect(calls[0].args.op).toBe("create");
	});
});
