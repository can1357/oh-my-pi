/**
 * Child-process harness for the `logits_to_keep` regression test.
 *
 * Two constraints shape this file:
 * - `onnxruntime-node` must never load in the parent test process: its NAPI finalizer
 *   segfaults Bun on Windows (issue #1606), which is why every inference path runs in a
 *   subprocess.
 * - Only one ORT build may load here. The hoisted root copy and the copy nested under
 *   `@huggingface/transformers` both ship `libonnxruntime.so.1`, so loading both makes
 *   the second `dlopen` fail. This resolves the nested copy, i.e. the one the tiny
 *   worker actually runs.
 *
 * The result is printed as JSON and the process exits before any finalizer can run.
 */
import { createRequire } from "node:module";
import * as path from "node:path";
import type { TextGenerationPipeline } from "@huggingface/transformers";
import type { InferenceSession, Tensor as OrtTensor } from "onnxruntime-node";
import {
	ensureLogitsToKeepFeed,
	needsLogitsToKeepFeed,
	type TransformersRuntime,
} from "@oh-my-pi/pi-coding-agent/tiny/worker";

/** The slice of `onnxruntime-node` this harness uses, so a version bump cannot shift the types. */
interface OrtRuntime {
	InferenceSession: { create(path: string): Promise<InferenceSession> };
	Tensor: new (type: string, data: readonly (bigint | number)[], dims: readonly number[]) => OrtTensor;
}

const ort = createRequire(import.meta.resolve("@huggingface/transformers"))("onnxruntime-node") as OrtRuntime;

const FIXTURE = path.join(import.meta.dir, "logits-to-keep.onnx");
const PROMPT_TOKENS = [0n, 1n, 2n, 3n];

/** Stand-in for transformers.js's `Tensor`: the shim only builds it and passes it on. */
class ShimTensor {
	readonly type: string;
	readonly data: readonly (bigint | number)[];
	readonly dims: readonly number[];

	constructor(type: string, data: readonly (bigint | number)[], dims: readonly number[]) {
		this.type = type;
		this.data = data;
		this.dims = dims;
	}
}

/** Convert the JS tensors `forward` receives into ORT tensors, as transformers.js does. */
function toOrtInputs(modelInputs: Record<string, unknown>): Record<string, OrtTensor> {
	const inputs: Record<string, OrtTensor> = {};
	for (const [name, value] of Object.entries(modelInputs)) {
		const tensor = value as { type: string; data: readonly (bigint | number)[]; dims: readonly number[] };
		inputs[name] = new ort.Tensor(tensor.type, tensor.data, tensor.dims);
	}
	return inputs;
}

/** Model whose forward crosses the same session boundary transformers.js does. */
function makeSessionModel(session: InferenceSession): TextGenerationPipeline["model"] {
	const model = {
		sessions: { model: { inputNames: [...session.inputNames] } },
		forward: (modelInputs: Record<string, unknown>) => session.run(toOrtInputs(modelInputs)),
	};
	return model as unknown as TextGenerationPipeline["model"];
}

/** Prompt inputs a decoder forwards before the shim adds the logits feed. */
function promptInputs(): Record<string, unknown> {
	const shape = [1, PROMPT_TOKENS.length];
	return {
		input_ids: new ShimTensor("int64", PROMPT_TOKENS, shape),
		attention_mask: new ShimTensor(
			"int64",
			PROMPT_TOKENS.map(() => 1n),
			shape,
		),
		position_ids: new ShimTensor(
			"int64",
			PROMPT_TOKENS.map(() => 0n),
			shape,
		),
	};
}

type Forward = (inputs: Record<string, unknown>) => Promise<Record<string, OrtTensor>>;

const forwardOf = (model: object): Forward => (model as { forward: Forward }).forward.bind(model);

/** Message of the error a call threw, or null when it resolved. */
async function failureOf(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run();
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function main(): Promise<void> {
	const session = await ort.InferenceSession.create(FIXTURE);
	const transformers = { Tensor: ShimTensor } as unknown as TransformersRuntime;
	const model = makeSessionModel(session);
	const report: Record<string, unknown> = {
		inputNames: session.inputNames,
		needsFeed: needsLogitsToKeepFeed(model),
		// Baseline: the failure this PR fixes, on a real session.
		baselineError: await failureOf(() => forwardOf(model)(promptInputs())),
	};

	report.feedInstalled = ensureLogitsToKeepFeed(transformers, model);
	const output = await forwardOf(model)(promptInputs());
	const logits = output.logits as OrtTensor;
	report.dims = logits.dims;
	report.data = Array.from(logits.data as Float32Array);

	// A non-int64 feed must be refused, so the shim's dtype is load-bearing.
	report.dtypeError = await failureOf(() =>
		forwardOf(model)({ ...promptInputs(), logits_to_keep: new ShimTensor("float32", [1], [1]) }),
	);

	console.log(JSON.stringify(report));
	await session.release();
	// Skip finalizers: the whole point of running this out of process.
	process.exit(0);
}

await main();
