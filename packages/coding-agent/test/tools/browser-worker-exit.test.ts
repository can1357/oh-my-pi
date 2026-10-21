import { afterAll, describe, expect, it, spyOn } from "bun:test";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import * as toolBridge from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	getTab,
	listTabs,
	releaseAllTabs,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { WorkerInbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"browser.tern": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-worker-exit-test" };

async function open(name: string, body: string): Promise<void> {
	await prelude.invoke({ action: "open", name, url: `data:text/html,<body>${body}</body>` }, context);
	expect(getTab(name)?.backend).toBe("worker");
}

async function run(name: string, code: string): Promise<unknown> {
	const { details } = await prelude.invoke({ action: "run", name, code, timeout: 20 }, context);
	return details && typeof details === "object" && "value" in details ? details.value : undefined;
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
	const error = await rejectionOf(promise);
	return error instanceof Error ? error.message : String(error);
}

// A rejection whose stack never touches the run's source, as a Puppeteer event handler's would: the
// worker's run guard leaves it alone, so it ends the worker.
const UNOWNED_REJECTION = `
	const err = new Error("library-internal");
	err.stack = "Error: library-internal\\n    at #onFileChooser (puppeteer/Page.js:1:1)";
	Promise.reject(err);
	await Promise.withResolvers().promise;
`;

/** Crash `name`'s worker and hold its reattachment until the returned `release` is called. */
async function crashAndHoldRecovery(name: string): Promise<{ crash: string; release: () => void }> {
	const tab = getTab(name);
	if (tab?.backend !== "worker") throw new Error("expected a worker tab");
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const worker = tab.worker;
	const terminate = worker.terminate.bind(worker);
	// The reattach starts by terminating the exited worker; parking it there keeps the recovery in flight.
	let calls = 0;
	worker.terminate = async () => {
		if (calls++ === 0) {
			entered.resolve();
			await gate.promise;
		}
		await terminate();
	};
	const crash = await messageOf(run(name, UNOWNED_REJECTION));
	await entered.promise;
	return { crash, release: () => gate.resolve() };
}

function textOf(parts: ReadonlyArray<TextContent | ImageContent>): string {
	return parts.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** End `name`'s worker while no run is in flight, as a late Puppeteer event rejection would, and wait out the reattach. */
async function crashWhileIdle(name: string): Promise<void> {
	const tab = getTab(name);
	if (tab?.backend !== "worker") throw new Error("expected a worker tab");
	const worker = tab.worker;
	let lastRun: Extract<WorkerInbound, { type: "run" }> | undefined;
	const send = worker.send.bind(worker);
	worker.send = (msg, transferList) => {
		if (msg.type === "run") lastRun = msg;
		send(msg, transferList);
	};
	expect(await run(name, "return 1;")).toBe(1);
	if (!lastRun) throw new Error("expected a recorded run");
	// The reattach starts by terminating the exited worker.
	const replacing = Promise.withResolvers<void>();
	const terminate = worker.terminate.bind(worker);
	worker.terminate = async () => {
		replacing.resolve();
		await terminate();
	};
	// A run the supervisor never registered: its rejection ends the worker with nothing pending.
	send({ ...lastRun, id: `${lastRun.id}-idle-crash`, code: UNOWNED_REJECTION });
	await replacing.promise;
	await tab.workerRecovery;
	expect(tab.state).toBe("alive");
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser tab worker exit", () => {
	it("fails the call at once and continues on the same page with a new worker", async () => {
		const name = "worker-exit-reattach";
		await open(name, "alive");
		await run(name, `await tab.evaluate(() => { document.body.dataset.mark = "kept"; });`);

		const started = Date.now();
		const crash = await messageOf(run(name, UNOWNED_REJECTION));
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(crash).toMatch(/Browser tab worker exited unexpectedly \(exit code \d+, library-internal\)/);
		expect(crash).toContain("the tab is being reattached");

		expect(listTabs().some(tab => tab.name === name)).toBe(true);
		expect(await run(name, "return await tab.evaluate(() => document.body.dataset.mark);")).toBe("kept");
	}, 30_000);

	it("does not name an earlier message error as the cause of a later exit", async () => {
		const name = "worker-exit-stale-cause";
		// Capture the tab's Bun worker to raise a `messageerror` on it, which leaves the worker running.
		const RealWorker = globalThis.Worker;
		let spawned: Worker | undefined;
		globalThis.Worker = class extends RealWorker {
			constructor(...args: ConstructorParameters<typeof Worker>) {
				super(...args);
				spawned = this;
			}
		};
		try {
			await open(name, "alive");
		} finally {
			globalThis.Worker = RealWorker;
		}
		if (!spawned) throw new Error("expected the tab's worker");
		spawned.dispatchEvent(new MessageEvent("messageerror", { data: "stale" }));
		expect(await run(name, "return 1;")).toBe(1);

		const crash = await messageOf(run(name, "process.exit(3);"));
		expect(crash).toContain("Browser tab worker exited unexpectedly (exit code 3)");
		expect(crash).not.toContain("stale");
	}, 30_000);

	it("aborts the host tool calls a crashed run had in flight, on reattach and on the crash-loop close", async () => {
		const name = "worker-exit-tool-call";
		await open(name, "alive");
		const signals: AbortSignal[] = [];
		const callTool = spyOn(toolBridge, "callSessionTool").mockImplementation(async (_name, _args, options) => {
			const { signal } = options;
			if (!signal) throw new Error("expected the tool call's abort signal");
			signals.push(signal);
			const aborted = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			throw signal.reason;
		});
		try {
			// The tool call is posted before the rejection ends the worker, so the host registers it first.
			const code = `void __omp_call_tool__("probe", {}); ${UNOWNED_REJECTION}`;
			expect(await messageOf(run(name, code))).toContain("the tab is being reattached");
			expect(await messageOf(run(name, code))).toContain("again right after being replaced");
			expect(signals.map(signal => signal.aborted)).toEqual([true, true]);
		} finally {
			callTool.mockRestore();
		}
	}, 30_000);

	it("closes the tab when the new worker exits again right away", async () => {
		const name = "worker-exit-loop";
		await open(name, "alive");
		expect(await messageOf(run(name, UNOWNED_REJECTION))).toContain("the tab is being reattached");

		const again = await messageOf(run(name, UNOWNED_REJECTION));
		expect(again).toContain("library-internal");
		expect(again).toContain("again right after being replaced");
		expect(listTabs().some(tab => tab.name === name)).toBe(false);
		expect(await messageOf(run(name, "return 1;"))).toContain(`Tab "${name}" was killed`);

		await open(name, "again");
		expect(await run(name, "return 3;")).toBe(3);
	}, 30_000);

	it("runs a call that arrives during the reattach on the reattached page", async () => {
		const name = "worker-exit-queued";
		await open(name, "original");
		const { crash, release } = await crashAndHoldRecovery(name);
		expect(crash).toContain("the tab is being reattached");

		const queued = run(name, "return await tab.evaluate(() => document.body.textContent);");
		release();
		expect(await queued).toBe("original");
	}, 30_000);

	it("settles a call waiting on the reattach when it is aborted or runs out of time", async () => {
		const name = "worker-exit-cancel";
		await open(name, "original");
		const { release } = await crashAndHoldRecovery(name);
		try {
			const ac = new AbortController();
			const aborted = messageOf(
				runInTab(name, { code: "return 1;", timeoutMs: 20_000, signal: ac.signal, session }),
			);
			const timedOut = messageOf(runInTab(name, { code: "return 1;", timeoutMs: 200, session }));
			ac.abort();
			expect(await aborted).toMatch(/abort/i);
			expect(await timedOut).toContain("was still being reattached after 200ms");
		} finally {
			release();
		}
		expect(await run(name, "return 2;")).toBe(2);
	}, 30_000);

	it("does not run a call waiting on the reattach on a tab reopened under the same name", async () => {
		const name = "worker-exit-reopened";
		await open(name, "original");
		const { release } = await crashAndHoldRecovery(name);

		const queued = messageOf(run(name, `await tab.evaluate(() => { document.body.dataset.queued = "ran"; });`));
		await releaseTab(name);
		await open(name, "replacement");
		release();

		expect(await queued).toContain("was closed while its worker was being reattached");
		expect(await run(name, "return await tab.evaluate(() => document.body.dataset.queued ?? null);")).toBeNull();
	}, 30_000);

	it("reuses a tab reopened during its reattach only once the reattach is over", async () => {
		const name = "worker-exit-reuse";
		await open(name, "original");
		await run(name, `await tab.evaluate(() => { document.body.dataset.mark = "kept"; });`);
		const before = getTab(name);
		if (before?.backend !== "worker") throw new Error("expected a worker tab");
		const oldWorker = before.worker;
		const { release } = await crashAndHoldRecovery(name);
		let settled = false;
		const reopened = prelude.invoke({ action: "open", name }, context).finally(() => {
			settled = true;
		});
		await Bun.sleep(300);
		expect(settled).toBe(false);
		release();
		await reopened;
		const after = getTab(name);
		expect(after).toBe(before);
		expect(after?.backend === "worker" && after.worker).not.toBe(oldWorker);
		expect(await run(name, "return await tab.evaluate(() => document.body.dataset.mark ?? null);")).toBe("kept");
	}, 30_000);

	it("opens a fresh tab when the tab is closed while an open waits on its reattach", async () => {
		const name = "worker-exit-reuse-closed";
		await open(name, "original");
		const before = getTab(name);
		const { release } = await crashAndHoldRecovery(name);
		const reopened = prelude.invoke({ action: "open", name }, context);
		await Bun.sleep(100);
		await releaseTab(name);
		release();
		await reopened;
		const after = getTab(name);
		expect(after).toBeDefined();
		expect(after).not.toBe(before);
		expect(after?.state).toBe("alive");
		expect(await run(name, "return 3;")).toBe(3);
	}, 30_000);

	it("does not run a call on the new worker when the old one exits while the tab is being resumed", async () => {
		const name = "worker-exit-during-resume";
		await open(name, "resume-target");
		const tab = getTab(name);
		if (tab?.backend !== "worker") throw new Error("expected a worker tab");
		const oldWorker = tab.worker;
		let lastRun: Extract<WorkerInbound, { type: "run" }> | undefined;
		const send = oldWorker.send.bind(oldWorker);
		oldWorker.send = (msg, transferList) => {
			if (msg.type === "run") lastRun = msg;
			send(msg, transferList);
		};
		await run(name, "return 1;");
		const target = tab.browser.browser.targets().find(t => t.type() === "page" && t.url().includes("resume-target"));
		if (!target) throw new Error("expected the tab's target");
		const createCDPSession = target.createCDPSession.bind(target);
		// The resume's first CDP roundtrip crashes the old worker and returns once its replacement took over.
		target.createCDPSession = async () => {
			target.createCDPSession = createCDPSession;
			if (!lastRun) throw new Error("expected a recorded run");
			// The reattach starts by terminating the exited worker, which also mutes that worker's exit listeners.
			const replacing = Promise.withResolvers<void>();
			const terminate = oldWorker.terminate.bind(oldWorker);
			oldWorker.terminate = async () => {
				replacing.resolve();
				await terminate();
			};
			send({ ...lastRun, id: `${lastRun.id}-crash`, code: UNOWNED_REJECTION });
			await replacing.promise;
			await tab.workerRecovery;
			return await createCDPSession();
		};
		tab.frozen = true;

		const failed = await messageOf(run(name, `await tab.evaluate(() => { document.body.dataset.ran = "yes"; });`));
		expect(failed).toContain("Browser tab worker exited unexpectedly");
		expect(tab.worker).not.toBe(oldWorker);
		expect(await run(name, "return await tab.evaluate(() => document.body.dataset.ran ?? null);")).toBeNull();
	}, 30_000);

	it("reports a worker exit with no run in flight on the next call, once", async () => {
		const name = "worker-exit-idle";
		await open(name, "idle");
		await crashWhileIdle(name);
		const text = textOf((await runInTab(name, { code: "return 1;", timeoutMs: 20_000, session })).displays);
		expect(text).toContain("since the last call; omp reattached the tab to a new worker on the same page");
		expect(text).toContain("library-internal");
		expect(text).toContain("init scripts");
		const next = await runInTab(name, { code: "return 2;", timeoutMs: 20_000, session });
		expect(textOf(next.displays)).not.toContain("since the last call");
	}, 30_000);

	it("reports a worker exit with no run in flight on the next open of the tab", async () => {
		const name = "worker-exit-idle-open";
		await open(name, "idle");
		await crashWhileIdle(name);
		const result = await prelude.invoke({ action: "open", name }, context);
		expect(textOf(result.content)).toContain("since the last call; omp reattached the tab");
	}, 30_000);

	it("waits for a reattach that starts while an open resumes the tab", async () => {
		const name = "worker-exit-open-resume";
		await open(name, "open-resume-target");
		const tab = getTab(name);
		if (tab?.backend !== "worker") throw new Error("expected a worker tab");
		const oldWorker = tab.worker;
		let lastRun: Extract<WorkerInbound, { type: "run" }> | undefined;
		const send = oldWorker.send.bind(oldWorker);
		oldWorker.send = (msg, transferList) => {
			if (msg.type === "run") lastRun = msg;
			send(msg, transferList);
		};
		await run(name, "return 1;");
		// The reattach starts by terminating the exited worker; parking it there keeps the reattach in flight.
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const terminate = oldWorker.terminate.bind(oldWorker);
		oldWorker.terminate = async () => {
			entered.resolve();
			await gate.promise;
			await terminate();
		};
		const target = tab.browser.browser
			.targets()
			.find(t => t.type() === "page" && t.url().includes("open-resume-target"));
		if (!target) throw new Error("expected the tab's target");
		const createCDPSession = target.createCDPSession.bind(target);
		// The resume's first CDP roundtrip crashes the worker and returns while its reattach is still held.
		target.createCDPSession = async () => {
			target.createCDPSession = createCDPSession;
			if (!lastRun) throw new Error("expected a recorded run");
			send({ ...lastRun, id: `${lastRun.id}-crash`, code: UNOWNED_REJECTION });
			await entered.promise;
			return await createCDPSession();
		};
		tab.frozen = true;

		let settled = false;
		const reopened = prelude.invoke({ action: "open", name }, context).finally(() => {
			settled = true;
		});
		// No event marks an open that wrongly returned early, so give it real time to do so.
		await Bun.sleep(500);
		expect(settled).toBe(false);
		gate.resolve();
		const text = textOf((await reopened).content);
		expect(text).toContain("since the last call; omp reattached the tab");
		expect(getTab(name)).toBe(tab);
		expect(tab.worker).not.toBe(oldWorker);
		expect(await run(name, "return 4;")).toBe(4);
	}, 30_000);
});
