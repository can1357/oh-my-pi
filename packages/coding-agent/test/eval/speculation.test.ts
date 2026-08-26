import { describe, expect, test } from "bun:test";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import {
	EvalSpeculationStore,
	findSpeculatableCalls,
	registerEvalSpeculation,
	SPECULATED_BRIDGE_TOOL,
	speculationKey,
} from "../../src/eval/speculation";
import type { ToolSession } from "../../src/tools";

/** Prompts recovered from `code`, in source order. */
function prompts(code: string, language: "js" | "py" = "js"): string[] {
	return findSpeculatableCalls(code, language).map(call => String(call.args.prompt));
}

describe("speculatable call scanner", () => {
	test("recovers a literal completion call and its prompt", () => {
		const calls = findSpeculatableCalls('const a = await completion("summarize this");', "js");
		expect(calls).toEqual([{ name: SPECULATED_BRIDGE_TOOL, args: { prompt: "summarize this" } }]);
	});

	test("recovers every call in source order so occurrences can be counted", () => {
		expect(prompts('completion("one");\ncompletion("two");\ncompletion("one");')).toEqual(["one", "two", "one"]);
	});

	// The scanner runs on a stream prefix. Speculating a call whose arguments are
	// still arriving would launch the wrong prompt.
	test("ignores a call whose string or argument list is still unterminated", () => {
		expect(prompts('const a = completion("half writ')).toEqual([]);
		expect(prompts('const a = completion("done"')).toEqual([]);
		expect(prompts("const a = completion(")).toEqual([]);
	});

	// The failure this prevents is speculating text the runtime never calls,
	// which bills a model request for a string inside a comment.
	test("ignores calls inside comments and string literals", () => {
		expect(prompts('// completion("commented")')).toEqual([]);
		expect(prompts('/* completion("blocked") */')).toEqual([]);
		expect(prompts(`const s = 'completion("quoted")';`)).toEqual([]);
		expect(prompts('# completion("hashed")', "py")).toEqual([]);
		expect(prompts('s = """completion("tripled")"""', "py")).toEqual([]);
	});

	test("ignores a same-named method on another object", () => {
		expect(prompts('client.completion("not ours")')).toEqual([]);
		expect(prompts('precompletion("not ours")')).toEqual([]);
	});

	// An escape decoder that disagreed with the runtime by one character would key
	// the speculation differently from the real call, wasting it silently.
	test("refuses literals it cannot reproduce exactly", () => {
		expect(prompts('completion("line\\nbreak")')).toEqual([]);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the subject under test
		expect(prompts("completion(`interpolated ${name}`)")).toEqual([]);
	});

	// Reconstructing bridge args for an options object means mirroring the
	// prelude's `optionsArg` normalization; a mismatch is a silent waste.
	test("refuses a call carrying options", () => {
		expect(prompts('completion("p", { model: "smol" })')).toEqual([]);
	});

	test("keeps scanning after a call it refused", () => {
		expect(prompts('completion("a", {x:1}); completion("b");')).toEqual(["b"]);
	});

	test("reads python triple-quoted prompts", () => {
		expect(prompts('x = completion("""multi\nline""")', "py")).toEqual(["multi\nline"]);
	});
});

describe("speculation key", () => {
	// Load-bearing: the launch side derives the key from source, the claim side
	// derives it from the args the prelude actually sends. `completion("x")` with
	// no options resolves to exactly `{ prompt: "x" }`, so these must agree or
	// every speculation misses.
	test("matches between a scanned call and the prelude's bridge args", () => {
		const [scanned] = findSpeculatableCalls('completion("do the thing")', "js");
		expect(scanned).toBeDefined();
		const fromPrelude = speculationKey(SPECULATED_BRIDGE_TOOL, { prompt: "do the thing" });
		expect(speculationKey(scanned?.name ?? "", scanned?.args ?? {})).toBe(fromPrelude);
	});

	test("separates different prompts", () => {
		expect(speculationKey("__completion__", { prompt: "a" })).not.toBe(
			speculationKey("__completion__", { prompt: "b" }),
		);
	});
});

function store(options: {
	run?: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
	enabled?: boolean;
	max?: number;
}) {
	const calls: Array<{ name: string; args: Record<string, unknown>; signal: AbortSignal }> = [];
	const instance = new EvalSpeculationStore({
		isEnabled: () => options.enabled ?? true,
		maxPerTurn: () => options.max ?? 10,
		run: (name, args, signal) => {
			calls.push({ name, args, signal });
			return options.run ? options.run(name, args, signal) : Promise.resolve("speculated");
		},
	});
	return { instance, calls };
}

describe("speculation store", () => {
	test("claims a launched result instead of dispatching again", async () => {
		const { instance, calls } = store({});
		instance.observe('completion("p")', "js");
		expect(calls).toHaveLength(1);
		const claim = instance.claim("__completion__", { prompt: "p" });
		expect(claim).toBeDefined();
		expect(await claim).toEqual({ ok: true, value: "speculated" });
	});

	test("returns undefined for a call it never speculated", () => {
		const { instance } = store({});
		instance.observe('completion("p")', "js");
		expect(instance.claim("__completion__", { prompt: "other" })).toBeUndefined();
	});

	// Completions are non-deterministic, so one speculated result must not satisfy
	// two call sites: the second must get its own, and a third must fall through.
	test("hands each identical call site its own result", () => {
		const { instance, calls } = store({});
		instance.observe('completion("p"); completion("p");', "js");
		expect(calls).toHaveLength(2);
		expect(instance.claim("__completion__", { prompt: "p" })).toBeDefined();
		expect(instance.claim("__completion__", { prompt: "p" })).toBeDefined();
		expect(instance.claim("__completion__", { prompt: "p" })).toBeUndefined();
	});

	// observe() runs once per streamed delta against a growing prefix.
	test("does not relaunch a call it already speculated as the prefix grows", () => {
		const { instance, calls } = store({});
		instance.observe('completion("p");', "js");
		instance.observe('completion("p");\nconst x = 1;', "js");
		instance.observe('completion("p");\nconst x = 1;\ncompletion("q");', "js");
		expect(calls.map(call => call.args.prompt)).toEqual(["p", "q"]);
	});

	test("stops launching at the per-turn ceiling", () => {
		const { instance, calls } = store({ max: 2 });
		instance.observe('completion("a"); completion("b"); completion("c");', "js");
		expect(calls).toHaveLength(2);
		expect(instance.launched).toBe(2);
	});

	test("launches nothing while disabled", () => {
		const { instance, calls } = store({ enabled: false });
		instance.observe('completion("p")', "js");
		expect(calls).toHaveLength(0);
		expect(instance.claim("__completion__", { prompt: "p" })).toBeUndefined();
	});

	// A speculation must never become the cell's failure: the caller falls back to
	// running the call itself.
	test("reports a rejected speculation as a miss rather than propagating it", async () => {
		const { instance } = store({ run: () => Promise.reject(new Error("upstream 503")) });
		instance.observe('completion("p")', "js");
		const claim = instance.claim("__completion__", { prompt: "p" });
		expect(await claim).toEqual({ ok: false });
	});

	test("aborts unclaimed speculations on reset so an unused one stops billing", () => {
		const pending = Promise.withResolvers<unknown>();
		const { instance, calls } = store({ run: () => pending.promise });
		instance.observe('completion("p")', "js");
		expect(calls[0]?.signal.aborted).toBe(false);
		instance.reset();
		expect(calls[0]?.signal.aborted).toBe(true);
		pending.resolve("ignored");
	});

	test("leaves a claimed speculation running through reset", () => {
		const pending = Promise.withResolvers<unknown>();
		const { instance, calls } = store({ run: () => pending.promise });
		instance.observe('completion("p")', "js");
		instance.claim("__completion__", { prompt: "p" });
		instance.reset();
		expect(calls[0]?.signal.aborted).toBe(false);
		pending.resolve("ignored");
	});

	test("clears the ceiling and parked results on reset", () => {
		const { instance } = store({ max: 1 });
		instance.observe('completion("p")', "js");
		expect(instance.launched).toBe(1);
		instance.reset();
		expect(instance.launched).toBe(0);
		expect(instance.claim("__completion__", { prompt: "p" })).toBeUndefined();
	});
});

describe("eval bridge integration", () => {
	// The seam that carries the whole feature: a parked result must satisfy the
	// real call without the bridge dispatching a second completion. The stub
	// session has no model registry, so a miss would surface as a thrown error
	// rather than a silent second request.
	test("returns a parked speculation instead of dispatching the completion", async () => {
		const session = { cwd: "/tmp" } as unknown as ToolSession;
		let dispatched = 0;
		const speculation = new EvalSpeculationStore({
			isEnabled: () => true,
			maxPerTurn: () => 4,
			run: () => {
				dispatched++;
				return Promise.resolve({ text: "from speculation" });
			},
		});
		registerEvalSpeculation(session, speculation);
		speculation.observe('completion("cached prompt")', "js");
		expect(dispatched).toBe(1);

		const value = await callSessionTool("__completion__", { prompt: "cached prompt" }, { session });

		expect(value).toEqual({ text: "from speculation" });
		expect(dispatched).toBe(1);
	});

	test("falls through to the real bridge when nothing was speculated", async () => {
		const session = { cwd: "/tmp" } as unknown as ToolSession;
		const speculation = new EvalSpeculationStore({
			isEnabled: () => true,
			maxPerTurn: () => 4,
			run: () => Promise.resolve({ text: "unused" }),
		});
		registerEvalSpeculation(session, speculation);
		speculation.observe('completion("a different prompt")', "js");

		// No parked entry for this prompt, so the bridge runs for real and fails
		// against the stub session. The specific rejection is incidental; that it
		// reaches the real path at all is the contract.
		await expect(callSessionTool("__completion__", { prompt: "uncached" }, { session })).rejects.toThrow();
	});
});
