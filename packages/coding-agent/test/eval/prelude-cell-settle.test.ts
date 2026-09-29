import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import type { EvalPreludeCell, EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

/** One settled cell as the counting prelude saw it. */
type Settled = { calls: number; failed: boolean; output?: string };

/** A prelude that counts its calls per cell and reports the count once the cell settles. */
function countingPrelude(settled: Settled[]): EvalPreludeDefinition {
	const calls = new Map<EvalPreludeCell, number>();
	return {
		name: "counter",
		documentation: "counter",
		javascript: "globalThis.counter = { hit: () => __omp_prelude__('counter', {}) };",
		python:
			"class _Counter:\n    async def hit(self):\n        return await _omp_prelude('counter', {})\n\ncounter = _Counter()\ndel _Counter",
		exports: ["counter"],
		async invoke(_parameters, context) {
			if (context.cell) calls.set(context.cell, (calls.get(context.cell) ?? 0) + 1);
			return { content: [], details: {} };
		},
		async settleCell(cell, outcome) {
			const count = calls.get(cell);
			if (count === undefined) return undefined;
			calls.delete(cell);
			settled.push({ calls: count, failed: outcome.failed, output: outcome.output });
			return { text: `counter: ${count} call(s) this cell` };
		},
	};
}

function evalSession(preludes: EvalPreludeDefinition[], id: string): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "async.enabled": false }),
		getEvalSessionId: () => id,
		getEvalPreludes: () => preludes,
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

describe("eval prelude cell settlement", () => {
	afterAll(async () => {
		await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
	});

	it("groups a JavaScript cell's prelude calls and appends the settle text after the cell's own output", async () => {
		const settled: Settled[] = [];
		const tool = new EvalTool(evalSession([countingPrelude(settled)], `prelude-settle-js-${crypto.randomUUID()}`));

		const first = await tool.execute("settle-js-1", {
			language: "js",
			code: "await counter.hit(); await counter.hit(); console.log('cell body');",
		});
		expect(text(first)).toBe("cell body\n\ncounter: 2 call(s) this cell");

		const quiet = await tool.execute("settle-js-2", { language: "js", code: "console.log('no prelude')" });
		expect(text(quiet)).toBe("no prelude");

		const failed = await tool.execute("settle-js-3", {
			language: "js",
			code: "await counter.hit(); throw new Error('boom');",
		});
		expect(text(failed)).toContain("counter: 1 call(s) this cell");
		expect(settled).toEqual([
			{ calls: 2, failed: false, output: expect.stringContaining("cell body") },
			{ calls: 1, failed: true, output: expect.any(String) },
		]);
	});

	it("groups a Python cell's prelude calls under one cell", async () => {
		const settled: Settled[] = [];
		const tool = new EvalTool(evalSession([countingPrelude(settled)], `prelude-settle-py-${crypto.randomUUID()}`));

		const result = await tool.execute("settle-py-1", {
			language: "py",
			code: "await counter.hit()\nawait counter.hit()\nawait counter.hit()\nprint('cell body')",
		});
		expect(text(result)).toBe("cell body\n\ncounter: 3 call(s) this cell");
		expect(settled).toEqual([{ calls: 3, failed: false, output: expect.stringContaining("cell body") }]);
	});

	it("keeps the cell's output and the other preludes' replies when one settle throws", async () => {
		const settled: Settled[] = [];
		const throwing: EvalPreludeDefinition = {
			name: "broken",
			documentation: "broken",
			javascript: "",
			python: "",
			exports: [],
			async invoke() {
				return { content: [] };
			},
			async settleCell() {
				throw new Error("settle exploded");
			},
		};
		const tool = new EvalTool(
			evalSession([throwing, countingPrelude(settled)], `prelude-settle-throw-${crypto.randomUUID()}`),
		);

		const result = await tool.execute("settle-throw-1", {
			language: "js",
			code: "await counter.hit(); console.log('cell body');",
		});
		expect(text(result)).toBe("cell body\n\ncounter: 1 call(s) this cell");
	});

	it("does not settle a cell that timed out", async () => {
		const settled: Settled[] = [];
		const tool = new EvalTool(
			evalSession([countingPrelude(settled)], `prelude-settle-timeout-${crypto.randomUUID()}`),
		);

		const result = await tool.execute("settle-timeout-1", {
			language: "js",
			code: "await counter.hit(); while (true) {}",
			timeout: 1,
		});
		expect(text(result)).not.toContain("counter:");
		expect(settled).toEqual([]);
	});

	it("does not wait on a settle hook that never returns once the call is aborted", async () => {
		const abort = new AbortController();
		const hanging: EvalPreludeDefinition = {
			name: "hanging",
			documentation: "hanging",
			javascript: "",
			python: "",
			exports: [],
			async invoke() {
				return { content: [] };
			},
			async settleCell() {
				abort.abort();
				return await new Promise<never>(() => {});
			},
		};
		const tool = new EvalTool(evalSession([hanging], `prelude-settle-hang-${crypto.randomUUID()}`));

		const result = await tool.execute(
			"settle-hang-1",
			{ language: "js", code: "console.log('cell body')" },
			abort.signal,
		);
		expect(text(result)).toContain("cell body");
	});

	it("ends a cell cancelled while it settles as cancelled", async () => {
		const abort = new AbortController();
		const cancelling: EvalPreludeDefinition = {
			name: "cancelling",
			documentation: "cancelling",
			javascript: "",
			python: "",
			exports: [],
			async invoke() {
				return { content: [] };
			},
			async settleCell() {
				abort.abort();
				return undefined;
			},
		};
		const tool = new EvalTool(evalSession([cancelling], `prelude-settle-cancel-${crypto.randomUUID()}`));

		const result = await tool.execute(
			"settle-cancel-1",
			{ language: "js", code: "console.log('cell body')" },
			abort.signal,
		);
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("cell body");
	});
});
