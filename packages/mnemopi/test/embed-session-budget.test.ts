// Contract: every ONNX session the local embedding stack creates from its
// model cache carries an explicit thread budget, and nothing else does.
// Without the budget onnxruntime starts one spinning intra-op thread per core,
// so a single recall query burns every core on a many-core host (measured:
// 3.85 CPU-seconds for one short query on 32 cores). The patched factory is
// onnxruntime-common's exported class, which an unrelated consumer can share,
// so the budget must stay confined to our model files and our scope.
import { describe, expect, spyOn, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type * as Ort from "onnxruntime-node";
import { defaultLocalModelInitializer, type LocalEmbeddingModel } from "../src/core/embeddings";
import * as runtime from "../src/core/fastembed-runtime";
const { applyEmbedSessionBudget, embedSessionOptions, withEmbedSessionBudget } = runtime;

type OrtSessionOptions = Ort.InferenceSession.SessionOptions;

const CACHE = path.resolve("/models/fastembed");
const MODEL = path.join(CACHE, "Qdrant_bge-base-en-v1.5-onnx-Q", "model_optimized.onnx");

interface RecordedCreate {
	calls: unknown[][];
	ort: typeof Ort;
	original: typeof Ort.InferenceSession.create;
}

/** A stand-in ORT module that records what `InferenceSession.create` received. */
function recordingOrt(): RecordedCreate {
	const calls: unknown[][] = [];
	const original = (...args: unknown[]) => {
		calls.push(args);
		return Promise.resolve({} as Ort.InferenceSession);
	};
	const ort = { InferenceSession: { create: original } } as unknown as typeof Ort;
	return { calls, ort, original: original as unknown as typeof Ort.InferenceSession.create };
}

function intraOpThreads(call: unknown[] | undefined, at = 1): number | undefined {
	return (call?.[at] as OrtSessionOptions | undefined)?.intraOpNumThreads;
}

describe("embedding session thread budget", () => {
	test("a cached model session gets a bounded intra-op pool, one inter-op thread and no spinning", async () => {
		const { calls, ort } = recordingOrt();
		applyEmbedSessionBudget(ort, 64, CACHE);

		await ort.InferenceSession.create(MODEL);

		const [, options] = calls[0] as [string, OrtSessionOptions];
		expect(options.intraOpNumThreads).toBe(4);
		expect(options.interOpNumThreads).toBe(1);
		expect(options.extra).toEqual({
			session: { intra_op: { allow_spinning: "0" }, inter_op: { allow_spinning: "0" } },
		});
	});

	test("a host with fewer cores than the cap gets its own core count", () => {
		expect(embedSessionOptions({}, 2).intraOpNumThreads).toBe(2);
		expect(embedSessionOptions({}, 0).intraOpNumThreads).toBe(1);
	});

	test("options the caller set win, including inside extra.session", async () => {
		const { calls, ort } = recordingOrt();
		applyEmbedSessionBudget(ort, 64, CACHE);

		await ort.InferenceSession.create(MODEL, {
			intraOpNumThreads: 16,
			interOpNumThreads: 2,
			graphOptimizationLevel: "all",
			extra: {
				session: {
					intra_op: { allow_spinning: "1" },
					inter_op: { allow_spinning: "1" },
					use_env_allocators: "1",
				},
			},
		});

		const [, options] = calls[0] as [string, OrtSessionOptions];
		expect(options.intraOpNumThreads).toBe(16);
		expect(options.interOpNumThreads).toBe(2);
		expect(options.graphOptimizationLevel).toBe("all");
		expect(options.extra).toEqual({
			session: {
				use_env_allocators: "1",
				intra_op: { allow_spinning: "1" },
				inter_op: { allow_spinning: "1" },
			},
		});
	});

	test("a session from outside the model cache keeps its own options while a scope is open", async () => {
		const { calls, ort } = recordingOrt();
		applyEmbedSessionBudget(ort, 64, CACHE);
		const buffer = new Uint8Array([1, 2, 3, 4]);

		await ort.InferenceSession.create("/elsewhere/other.onnx");
		await ort.InferenceSession.create(`${CACHE}-sibling/model.onnx`);
		await ort.InferenceSession.create(buffer.buffer, 0, 4);

		expect(calls).toEqual([["/elsewhere/other.onnx"], [`${CACHE}-sibling/model.onnx`], [buffer.buffer, 0, 4]]);
	});

	test("releasing the last scope puts the original create back", async () => {
		const { calls, ort, original } = recordingOrt();
		const release = applyEmbedSessionBudget(ort, 64, CACHE);
		release();

		await ort.InferenceSession.create(MODEL);

		expect(ort.InferenceSession.create).toBe(original);
		expect(calls[0]).toEqual([MODEL]);
	});

	test("overlapping scopes released oldest first still put the original create back", async () => {
		const { calls, ort, original } = recordingOrt();
		const first = applyEmbedSessionBudget(ort, 64, CACHE);
		const second = applyEmbedSessionBudget(ort, 2, CACHE);

		await ort.InferenceSession.create(MODEL);
		first();
		await ort.InferenceSession.create(MODEL);
		second();

		// The newest open scope's values apply; the second scope still holds after the first leaves.
		expect(intraOpThreads(calls[0])).toBe(2);
		expect(intraOpThreads(calls[1])).toBe(2);
		expect(ort.InferenceSession.create).toBe(original);
	});

	test("releasing a scope twice does not end a scope opened after it", async () => {
		const { calls, ort } = recordingOrt();
		// An older scope keeps the wrapper installed, so the stale release meets the later scope.
		applyEmbedSessionBudget(ort, 64, CACHE);
		const stale = applyEmbedSessionBudget(ort, 8, CACHE);
		stale();
		applyEmbedSessionBudget(ort, 2, CACHE);
		stale();

		await ort.InferenceSession.create(MODEL);

		expect(intraOpThreads(calls[0])).toBe(2);
	});

	test("a wrapper installed over ours is left in place when our last scope ends", async () => {
		const { calls, ort } = recordingOrt();
		const release = applyEmbedSessionBudget(ort, 64, CACHE);
		const ours = ort.InferenceSession.create;
		const theirs = ((...args: Parameters<typeof ours>) => ours(...args)) as typeof ours;
		ort.InferenceSession.create = theirs;
		release();

		await ort.InferenceSession.create(MODEL);

		expect(ort.InferenceSession.create).toBe(theirs);
		expect(calls[0]).toEqual([MODEL]);
	});

	test("each open scope budgets its own cache while another scope is open", async () => {
		const { calls, ort } = recordingOrt();
		const otherCache = path.resolve("/models/other");
		applyEmbedSessionBudget(ort, 64, CACHE);
		applyEmbedSessionBudget(ort, 2, otherCache);

		await ort.InferenceSession.create(MODEL);
		await ort.InferenceSession.create(path.join(otherCache, "model_optimized.onnx"));

		expect(intraOpThreads(calls[0])).toBe(4);
		expect(intraOpThreads(calls[1])).toBe(2);
	});

	test("a wrapper below ours that unwinds does not leave the factory unbudgetable", async () => {
		const { calls, ort } = recordingOrt();
		const beneath = ort.InferenceSession.create;
		// Someone else wrapped first and restores unconditionally, taking our wrapper with it.
		ort.InferenceSession.create = ((...args: Parameters<typeof beneath>) => beneath(...args)) as typeof beneath;
		const release = applyEmbedSessionBudget(ort, 64, CACHE);
		ort.InferenceSession.create = beneath;
		release();

		applyEmbedSessionBudget(ort, 64, CACHE);
		await ort.InferenceSession.create(MODEL);

		expect(intraOpThreads(calls[0])).toBe(4);
	});
});

describe("defaultLocalModelInitializer", () => {
	test("builds its sessions inside the budget for its own cache, and leaves create as it found it", async () => {
		const { calls, ort, original } = recordingOrt();
		const model = { embed: async () => [] } as unknown as LocalEmbeddingModel;
		const realWithBudget = runtime.withEmbedSessionBudget;
		const budgetSpy = spyOn(runtime, "withEmbedSessionBudget").mockImplementation(((
			cacheRoot: string,
			work: () => Promise<unknown>,
		) => realWithBudget(cacheRoot, work, () => ort)) as typeof realWithBudget);
		const loadSpy = spyOn(runtime, "loadFastembed").mockResolvedValue({
			FlagEmbedding: {
				init: async ({ cacheDir }: { cacheDir: string }) => {
					await ort.InferenceSession.create(path.join(cacheDir, "Qdrant_bge-base-en-v1.5-onnx-Q", "model.onnx"));
					return model;
				},
			},
		} as never);
		try {
			const loaded = await defaultLocalModelInitializer({
				model: "fast-bge-base-en-v1.5" as never,
				cacheDir: CACHE,
			});

			expect(loaded).toBe(model);
			expect(intraOpThreads(calls[0])).toBe(Math.max(1, Math.min(4, os.availableParallelism())));
			expect(ort.InferenceSession.create).toBe(original);
		} finally {
			budgetSpy.mockRestore();
			loadSpy.mockRestore();
		}
	});
});

describe("withEmbedSessionBudget", () => {
	test("budgets sessions only while the work runs, also when it fails", async () => {
		const { calls, ort, original } = recordingOrt();

		await withEmbedSessionBudget(
			CACHE,
			() => ort.InferenceSession.create(MODEL),
			() => ort,
		);
		const failure = withEmbedSessionBudget(
			CACHE,
			async () => {
				await ort.InferenceSession.create(MODEL);
				throw new Error("init failed");
			},
			() => ort,
		);

		await expect(failure).rejects.toThrow("init failed");
		expect(intraOpThreads(calls[0])).toBe(4);
		expect(intraOpThreads(calls[1])).toBe(4);
		expect(ort.InferenceSession.create).toBe(original);
	});

	test("an onnxruntime that cannot be loaded leaves the work to run unbudgeted", async () => {
		const result = await withEmbedSessionBudget(
			CACHE,
			async () => "embedded",
			() => {
				throw new Error("Cannot find module onnxruntime-node");
			},
		);

		expect(result).toBe("embedded");
	});
});
