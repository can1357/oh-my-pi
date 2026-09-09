import { describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";

function makeRuntime(): { runtime: JsRuntime; hooks: RuntimeHooks; texts: string[] } {
	const texts: string[] = [];
	const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "test" });
	const hooks: RuntimeHooks = {
		onText: (chunk: string) => {
			texts.push(chunk);
		},
		onDisplay: (_output: JsDisplayOutput) => {},
		callTool: async () => undefined,
	};
	return { runtime, hooks, texts };
}

describe("process.stdout/stderr capture in JS eval", () => {
	it("routes process.stdout.write into the cell output with exact bytes and no added newline", async () => {
		const { runtime, hooks, texts } = makeRuntime();
		await runtime.run("process.stdout.write('a'); process.stdout.write('b');", undefined, hooks);
		// Concatenation with no separator proves writes are passed through verbatim
		// (the old behavior lost the text entirely and captured the boolean return).
		expect(texts.join("")).toBe("ab");
	});

	it("routes process.stderr.write into the cell output", async () => {
		const { runtime, hooks, texts } = makeRuntime();
		await runtime.run("process.stderr.write('oops');", undefined, hooks);
		expect(texts.join("")).toBe("oops");
	});

	it("decodes Buffer chunks written to process.stdout", async () => {
		const { runtime, hooks, texts } = makeRuntime();
		await runtime.run("process.stdout.write(Buffer.from('héllo', 'utf8'));", undefined, hooks);
		expect(texts.join("")).toBe("héllo");
	});
});
