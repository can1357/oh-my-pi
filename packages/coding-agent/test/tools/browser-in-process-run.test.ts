import { describe, expect, it } from "bun:test";
import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import { type InProcessRunTab, runInProcessTab } from "@oh-my-pi/pi-coding-agent/tools/browser/in-process-run";
import type { SessionSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

/** A backend tab (Tern, WebKit, cmux) whose `tab.run` code executes in this process. */
class FakeTab implements InProcessRunTab {
	readonly runLabel = "fake-run";
	readonly page = {};
	readonly browser = {};
	#runtime: JsRuntime | undefined;
	discarded = 0;

	ensureRuntime(session: SessionSnapshot): JsRuntime {
		this.#runtime ??= new JsRuntime({ initialCwd: session.cwd, sessionId: `fake-${crypto.randomUUID()}` });
		return this.#runtime;
	}

	setRunContext(): void {}

	clearRunContext(): void {}

	discardRuntime(): void {
		this.discarded++;
		this.#runtime?.dispose();
		this.#runtime = undefined;
	}
}

const snapshot: SessionSnapshot = { cwd: process.cwd() };
const session = { cwd: process.cwd() } as ToolSession;

function run(tab: FakeTab, code: string, timeoutMs = 5_000) {
	return runInProcessTab(tab, { code, timeoutMs, session, snapshot });
}

describe("in-process browser runs", () => {
	it("runs code of different tabs at once by taking turns in the shared realm", async () => {
		const first = new FakeTab();
		const second = new FakeTab();
		const gate = Promise.withResolvers<void>();
		const globals = globalThis as Record<string, unknown>;
		globals.__inProcessGate = gate.promise;
		try {
			// The first run holds the realm until the gate opens, while the second is already waiting for it.
			const runs = Promise.all([
				run(first, "await globalThis.__inProcessGate; return 1;"),
				run(second, "return 2;"),
			]);
			gate.resolve();
			expect((await runs).map(result => result.returnValue)).toEqual([1, 2]);
		} finally {
			delete globals.__inProcessGate;
			first.discardRuntime();
			second.discardRuntime();
		}
	});

	it("frees the realm for other tabs when a run never settles", async () => {
		const hung = new FakeTab();
		const other = new FakeTab();
		try {
			// The run's own budget is the timer under test: a short real one.
			await expect(run(hung, "await Promise.withResolvers().promise;", 100)).rejects.toThrow(
				"timed out after 100ms",
			);
			expect(hung.discarded).toBe(1);
			expect((await run(other, "return 3;")).returnValue).toBe(3);
		} finally {
			hung.discardRuntime();
			other.discardRuntime();
		}
	});
});
