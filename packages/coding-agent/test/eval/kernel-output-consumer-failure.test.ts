import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

type Language = "py" | "js";

function makeSession(evalSessionId: string): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => evalSessionId,
	};
}

interface Cell {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
}

/** Runs one cell in the session's retained runtime with a caller-supplied output consumer. */
async function run(
	session: ToolSession,
	language: Language,
	code: string,
	onChunk?: (chunk: string) => void,
): Promise<Cell> {
	const sessionId = session.getEvalSessionId?.() ?? "missing";
	const result =
		language === "py"
			? await executePython(code, { cwd: session.cwd, sessionId, toolSession: session, onChunk, timeoutMs: 20_000 })
			: await executeJs(code, { cwd: session.cwd, sessionId, session, onChunk, timeoutMs: 20_000 });
	return { output: result.output, exitCode: result.exitCode, cancelled: result.cancelled };
}

const PID_CELL: Record<Language, string> = {
	py: "import os\nprint('pid', os.getpid())",
	js: "print('pid', process.pid)",
};

function pidOf(cell: Cell): string {
	const match = /pid (\d+)/.exec(cell.output);
	if (!match) throw new Error(`no pid in cell output: ${cell.output}`);
	return match[1]!;
}

/**
 * Sets a variable and prints two lines with a pause between them, so the second
 * arrives as a later message, after the consumer refused the first. The pause
 * runs inside the real runtime, which a fake clock cannot reach.
 */
const TWO_LINES: Record<Language, string> = {
	py: "import time\nkept = 42\nprint('one', flush=True)\ntime.sleep(0.3)\nprint('two', flush=True)",
	js: "var kept = 42; print('one'); await new Promise(resolve => setTimeout(resolve, 300)); print('two');",
};

const READ_KEPT: Record<Language, string> = {
	py: "print('kept', kept)",
	js: "print('kept', kept)",
};

describe("eval output consumer failure", () => {
	afterEach(async () => {
		await Promise.all([disposeAllKernelSessions(), disposeAllVmContexts()]);
	});

	for (const language of ["py", "js"] as const) {
		it(`${language}: a consumer that throws mid-cell leaves the cell, the runtime and its variables intact, and is reported`, async () => {
			const session = makeSession(`consumer-failure-${language}-${crypto.randomUUID()}`);
			const before = await run(session, language, PID_CELL[language]);

			const delivered: string[] = [];
			const failed = await run(session, language, TWO_LINES[language], chunk => {
				if (chunk.includes("one")) throw new Error("consumer refused a chunk");
				delivered.push(chunk);
			});
			const after = await run(session, language, `${PID_CELL[language]}\n${READ_KEPT[language]}`);

			// The cell ran to completion instead of hanging until its timeout killed the runtime.
			expect(failed.cancelled).toBe(false);
			expect(failed.exitCode).toBe(0);
			// The result holds the whole output, including what arrived after the consumer threw.
			expect(failed.output).toContain("one\n");
			expect(failed.output).toContain("two\n");
			// The consumer kept receiving the cell's later output.
			expect(delivered.join("")).toContain("two");
			// The failure reaches the caller when the cell is done, naming the consumer and the risk.
			expect(failed.output).toContain("stream output consumer failed: consumer refused a chunk");
			expect(failed.output).toContain("output shown while it ran may be incomplete");
			// Same process, state intact.
			expect(pidOf(after)).toBe(pidOf(before));
			expect(after.output).toContain("kept 42");
		}, 120_000);

		it(`${language}: a cell whose consumer does not throw is unchanged`, async () => {
			const session = makeSession(`consumer-ok-${language}-${crypto.randomUUID()}`);
			const delivered: string[] = [];
			const cell = await run(session, language, TWO_LINES[language], chunk => {
				delivered.push(chunk);
			});

			expect(cell.cancelled).toBe(false);
			expect(cell.exitCode).toBe(0);
			expect(cell.output).toBe("one\ntwo\n");
			expect(delivered.join("")).toBe("one\ntwo\n");
		}, 120_000);
	}

	it("py: a consumer that throws on a failing cell's traceback is reported, and the kernel keeps its variables", async () => {
		const session = makeSession(`consumer-failure-traceback-${crypto.randomUUID()}`);
		const before = await run(session, "py", `${PID_CELL.py}\nkept = 42`);

		const failed = await run(session, "py", "raise ValueError('cell failed')", chunk => {
			if (chunk.includes("ValueError")) throw new Error("consumer refused the traceback");
		});
		const after = await run(session, "py", `${PID_CELL.py}\n${READ_KEPT.py}`);

		expect(failed.cancelled).toBe(false);
		expect(failed.exitCode).toBe(1);
		expect(failed.output).toContain("ValueError: cell failed");
		expect(failed.output).toContain("stream output consumer failed: consumer refused the traceback");
		expect(pidOf(after)).toBe(pidOf(before));
		expect(after.output).toContain("kept 42");
	}, 120_000);
});
