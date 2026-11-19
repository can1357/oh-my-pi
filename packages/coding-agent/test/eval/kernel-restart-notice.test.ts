import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { getEvalState } from "@oh-my-pi/pi-coding-agent/eval/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

type Language = "py" | "js";

const NOTICE: Record<Language, string> = {
	py: "Kernel restarted: the previous Python kernel is dead; state is unavailable. Re-run needed setup",
	js: "Kernel restarted: the previous JS worker is dead; state is unavailable. Re-run needed setup",
};

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
	text: string;
	isError: boolean;
}

async function run(
	tool: EvalTool,
	language: Language,
	code: string,
	options?: { signal?: AbortSignal; onText?: (text: string) => void },
): Promise<Cell> {
	const result = await tool.execute(
		`call-${crypto.randomUUID()}`,
		{ language, code, timeout: 60 },
		options?.signal,
		options?.onText
			? update => {
					const text = update.content?.find(block => block.type === "text")?.text;
					if (text) options.onText?.(text);
				}
			: undefined,
	);
	const text = result.content.find(block => block.type === "text")?.text ?? "";
	return { text, isError: result.details?.isError === true };
}

const PID_CELL: Record<Language, string> = {
	py: "import os\nprint('pid', os.getpid())",
	js: "print('pid', process.pid)",
};

function pidOf(cell: Cell): number {
	const match = /pid (\d+)/.exec(cell.text);
	if (!match) throw new Error(`no pid in cell output: ${cell.text}`);
	return Number(match[1]);
}

/**
 * SIGKILL the runtime process, then wait until the host has recorded it dead.
 * The death is a real OS event in a child the host owns and nothing exposes an
 * event for it, so the test polls the host's eval-state registry: fake timers
 * cannot advance a process exit.
 */
async function killRuntime(session: ToolSession, language: Language, pid: number): Promise<void> {
	// A JS cell on the Bun Worker fallback reports the test runner's own pid.
	if (pid === process.pid) throw new Error("runtime runs inside the test process; refusing to SIGKILL it");
	process.kill(pid, "SIGKILL");
	const runtime = language === "py" ? "python" : "js";
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const state = getEvalState(session)?.runtimes.find(entry => entry.language === runtime);
		if (state && !state.alive) return;
		await Bun.sleep(20);
	}
	throw new Error(`host never saw ${runtime} runtime ${pid} die`);
}

function expectNotice(cell: Cell, language: Language): void {
	expect(cell.text.trimStart().startsWith(NOTICE[language])).toBe(true);
	expect(cell.text).toContain("variables, imports and definitions from earlier cells are gone");
}

function expectNoNotice(cell: Cell): void {
	expect(cell.text).not.toContain("Kernel restarted:");
}

const SET_VALUE: Record<Language, string> = {
	py: "restart_probe = 41",
	js: "var restartProbe = 41;",
};

const READ_VALUE: Record<Language, string> = {
	py: "print(restart_probe + 1)",
	js: "print(restartProbe + 1)",
};

describe("eval kernel restart notice", () => {
	afterEach(async () => {
		await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
	});

	for (const language of ["py", "js"] as const) {
		it(`${language}: the first cell after the runtime is killed between cells says its state is gone`, async () => {
			const session = makeSession(`restart-notice-kill-${language}-${crypto.randomUUID()}`);
			const tool = new EvalTool(session);

			const first = await run(tool, language, `${SET_VALUE[language]}\n${PID_CELL[language]}`);
			expectNoNotice(first);
			const survived = await run(tool, language, READ_VALUE[language]);
			expectNoNotice(survived);
			expect(survived.text).toContain("42");

			await killRuntime(session, language, pidOf(first));

			const afterKill = await run(tool, language, READ_VALUE[language]);
			expectNotice(afterKill, language);
			expect(afterKill.isError).toBe(true);
			expect(afterKill.text).toMatch(language === "py" ? /NameError/ : /restartProbe/);

			const next = await run(tool, language, PID_CELL[language]);
			expectNoNotice(next);
		}, 120_000);
	}

	it("js: the first cell after a cancelled cell says the worker state is gone", async () => {
		const session = makeSession(`restart-notice-cancel-js-${crypto.randomUUID()}`);
		const tool = new EvalTool(session);

		await run(tool, "js", SET_VALUE.js);
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const cancelled = run(tool, "js", "print('waiting'); await new Promise(() => {});", {
			signal: controller.signal,
			onText: text => {
				if (text.includes("waiting")) started.resolve();
			},
		});
		await started.promise;
		controller.abort(new DOMException("user cancelled", "AbortError"));
		await cancelled.catch(() => undefined);

		const next = await run(tool, "js", READ_VALUE.js);
		expectNotice(next, "js");
		const after = await run(tool, "js", "print('after')");
		expectNoNotice(after);
	}, 120_000);
});
