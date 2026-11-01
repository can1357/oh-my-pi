import { describe, expect, it } from "bun:test";
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

describe("logits_to_keep feed", () => {
	it("supplies a one-element int64 last-token feed when a session declares logits_to_keep", async () => {
		const { model, seen } = makeModel(["input_ids", "attention_mask", "position_ids", "logits_to_keep"]);
		expect(needsLogitsToKeepFeed(model)).toBe(true);
		expect(ensureLogitsToKeepFeed(makeRuntime(), model)).toBe(true);

		await forwardOf(model)({ input_ids: "ids" });

		expect(seen).toHaveLength(1);
		expect(seen[0]!.input_ids).toBe("ids");
		const feed = seen[0]!.logits_to_keep as { type: string; data: readonly bigint[]; dims: readonly number[] };
		expect(feed.type).toBe("int64");
		expect(feed.data).toEqual([1n]);
		expect(feed.dims).toEqual([1]);
	});

	it("leaves graphs that use num_logits_to_keep untouched", async () => {
		const { model, seen } = makeModel(["input_ids", "num_logits_to_keep"]);
		expect(needsLogitsToKeepFeed(model)).toBe(false);
		expect(ensureLogitsToKeepFeed(makeRuntime(), model)).toBe(false);

		await forwardOf(model)({ input_ids: "ids", num_logits_to_keep: 7 });

		expect(seen[0]).toEqual({ input_ids: "ids", num_logits_to_keep: 7 });
	});

	it("keeps a caller-supplied logits_to_keep over the shim value", async () => {
		const { model, seen } = makeModel(["input_ids", "logits_to_keep"]);
		ensureLogitsToKeepFeed(makeRuntime(), model);

		await forwardOf(model)({ input_ids: "ids", logits_to_keep: "explicit" });

		expect(seen[0]!.logits_to_keep).toBe("explicit");
	});
});
