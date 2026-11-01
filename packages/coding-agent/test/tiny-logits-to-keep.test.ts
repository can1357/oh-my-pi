import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { TextGenerationPipeline } from "@huggingface/transformers";
import {
	ensureLogitsToKeepFeed,
	needsLogitsToKeepFeed,
	type TransformersRuntime,
} from "@oh-my-pi/pi-coding-agent/tiny/worker";

/** The model surface these tests read: whatever `forward` the object holds when called. */
interface ShimTarget {
	forward(modelInputs: Record<string, unknown>): Promise<unknown>;
	sessions: Record<string, { inputNames: string[] }>;
}

/** Minimal Tensor stand-in: records constructor args so the feed shape is assertable. */
function makeRuntime(): TransformersRuntime {
	class FakeTensor {
		readonly type: string;
		readonly data: readonly bigint[];
		readonly dims: readonly number[];
		constructor(type: string, data: readonly bigint[], dims: readonly number[]) {
			this.type = type;
			this.data = data;
			this.dims = dims;
		}
	}
	const runtime = { Tensor: FakeTensor };
	return runtime as unknown as TransformersRuntime;
}

/** Model stand-in: one session declaring `inputs`, and a forward that echoes what it received. */
function makeModel(inputs: readonly string[]): {
	model: TextGenerationPipeline["model"];
	seen: Record<string, unknown>[];
} {
	const seen: Record<string, unknown>[] = [];
	const target: ShimTarget = {
		sessions: { model: { inputNames: [...inputs] } },
		forward: async modelInputs => {
			seen.push(modelInputs);
			return {};
		},
	};
	return { model: target as unknown as TextGenerationPipeline["model"], seen };
}

/** Read the model's current `forward`, i.e. the shim's wrapper once installed. */
function forwardOf(model: TextGenerationPipeline["model"]): ShimTarget["forward"] {
	const target = model as unknown as ShimTarget;
	return target.forward.bind(target);
}

describe("logits_to_keep feed gate", () => {
	it("leaves graphs that use num_logits_to_keep untouched", async () => {
		const { model, seen } = makeModel(["input_ids", "num_logits_to_keep"]);
		expect(needsLogitsToKeepFeed(model)).toBe(false);
		expect(ensureLogitsToKeepFeed(makeRuntime(), model)).toBe(false);

		await forwardOf(model)({ input_ids: "ids", num_logits_to_keep: 7 });

		expect(seen[0]).toEqual({ input_ids: "ids", num_logits_to_keep: 7 });
	});
});

// ── Real ONNX session ────────────────────────────────────────────────
// The cases above prove the merge; the harness proves a session that *requires*
// logits_to_keep accepts the merged tensor. `onnxruntime-node` must not load in this
// process (its NAPI finalizer segfaults Bun on Windows, issue #1606), so the session
// work lives in fixtures/onnx/run-logits-to-keep.ts and runs as a child process.

const HARNESS_PATH = path.join(import.meta.dir, "fixtures", "onnx", "run-logits-to-keep.ts");

/** Report printed by the child harness. */
interface SessionReport {
	inputNames: string[];
	needsFeed: boolean;
	baselineError: string | null;
	feedInstalled: boolean;
	dims: number[];
	data: number[];
	dtypeError: string | null;
}

/** Run the harness to completion and return its exit code plus both streams. */
async function runHarness(): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, HARNESS_PATH], { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

describe("logits_to_keep feed (real ONNX session)", () => {
	it("is required by the graph, unblocks it once installed, and rejects a wrong dtype", async () => {
		const { code, stdout } = await runHarness();

		// A native crash at teardown would exit non-zero instead of printing a report.
		expect(code).toBe(0);

		const line = stdout.trim().split("\n").at(-1) ?? "";
		const report = JSON.parse(line) as SessionReport;

		expect(report.inputNames).toContain("logits_to_keep");
		expect(report.needsFeed).toBe(true);
		// Baseline: the failure this PR fixes, reproduced against a real session.
		expect(report.baselineError).toMatch(/logits_to_keep.*is missing in 'feeds'/);
		expect(report.feedInstalled).toBe(true);
		// keep=1 keeps the last token only, so the int64 [1] feed is honoured.
		expect(report.dims).toEqual([1, 1]);
		expect(report.data).toEqual([3]);
		// A float32 feed is refused, so the shim's dtype is load-bearing.
		expect(report.dtypeError).toMatch(/int64/);
	}, 60_000);
});
