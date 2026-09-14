import { afterEach, expect, it, vi } from "bun:test";
import type { Browser, Dialog, Page } from "puppeteer-core";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import { loadPuppeteerInWorker } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { Transport, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { spawnInlineWorkerForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

afterEach(() => vi.restoreAllMocks());

class WorkerTransport implements Transport {
	#receive?: (message: WorkerInbound | WorkerOutbound) => void;
	readonly sent: WorkerOutbound[] = [];

	send(message: WorkerInbound | WorkerOutbound): void {
		if (
			message.type === "setup" ||
			message.type === "ready" ||
			message.type === "init-failed" ||
			message.type === "selected" ||
			message.type === "select-failed" ||
			message.type === "result" ||
			message.type === "tool-call" ||
			message.type === "log" ||
			message.type === "closed"
		) {
			this.sent.push(message);
		}
	}

	onMessage(handler: (message: WorkerInbound | WorkerOutbound) => void): () => void {
		this.#receive = handler;
		return () => {
			this.#receive = undefined;
		};
	}

	close(): void {}

	inbound(message: WorkerInbound): void {
		this.#receive?.(message);
	}

	async waitFor<T extends WorkerOutbound>(predicate: (message: WorkerOutbound) => message is T): Promise<T> {
		const existing = this.sent.find(predicate);
		if (existing) return existing;
		for (;;) {
			await Bun.sleep(0);
			const message = this.sent.find(predicate);
			if (message) return message;
		}
	}
}

class ControlledBiDiPage {
	readonly frame: { _id: string; goto: () => Promise<void>; setContent: () => Promise<void> };
	readonly evaluations: unknown[][] = [];
	readonly #listeners = new Map<string, Set<(value: unknown) => void>>();

	constructor(
		readonly id: string,
		readonly label: string,
	) {
		this.frame = {
			_id: id,
			goto: async () => {},
			setContent: async () => {},
		};
	}

	mainFrame(): ControlledBiDiPage["frame"] {
		return this.frame;
	}

	frames(): ControlledBiDiPage["frame"][] {
		return [this.frame];
	}

	viewport(): { width: number; height: number } {
		return { width: 800, height: 600 };
	}

	url(): string {
		return `https://${this.label}.example/`;
	}

	async title(): Promise<string> {
		return this.label;
	}

	isClosed(): boolean {
		return false;
	}

	on(event: string, handler: (value: unknown) => void): this {
		let handlers = this.#listeners.get(event);
		if (!handlers) {
			handlers = new Set();
			this.#listeners.set(event, handlers);
		}
		handlers.add(handler);
		return this;
	}

	off(event: string, handler: (value: unknown) => void): this {
		this.#listeners.get(event)?.delete(handler);
		return this;
	}

	once(event: string, handler: (value: unknown) => void): this {
		const once = (value: unknown): void => {
			this.off(event, once);
			handler(value);
		};
		return this.on(event, once);
	}

	removeAllListeners(event?: string): this {
		if (event) this.#listeners.delete(event);
		else this.#listeners.clear();
		return this;
	}

	emit(event: string, value: unknown): void {
		for (const handler of this.#listeners.get(event) ?? []) handler(value);
	}

	async evaluate(...args: unknown[]): Promise<string> {
		this.evaluations.push(args);
		return `evaluated-${this.label}`;
	}
	async goto(): Promise<void> {}
	async reload(): Promise<void> {}
	async goBack(): Promise<void> {}
	async goForward(): Promise<void> {}
	async setContent(): Promise<void> {}
	async setRequestInterception(): Promise<void> {}
}

function controlledDialog(): { dialog: Dialog; accepted: () => number; dismissed: () => number } {
	let accepts = 0;
	let dismisses = 0;
	return {
		dialog: {
			type: () => "confirm",
			message: () => "policy check",
			accept: async () => {
				accepts += 1;
			},
			dismiss: async () => {
				dismisses += 1;
			},
		} as unknown as Dialog,
		accepted: () => accepts,
		dismissed: () => dismisses,
	};
}

async function initializeBiDiWorker(pages: ControlledBiDiPage[]): Promise<{ transport: WorkerTransport }> {
	const puppeteer = await loadPuppeteerInWorker(getPuppeteerDir());
	const browser = {
		connected: true,
		pages: async () => pages as unknown as Page[],
		browserContexts: () => [],
		targets: () => [],
		disconnect: async () => {},
	} as unknown as Browser;
	vi.spyOn(puppeteer, "connect").mockResolvedValue(browser);
	const transport = new WorkerTransport();
	new WorkerCore(transport, false);
	transport.inbound({
		type: "init",
		payload: {
			mode: "attach",
			protocol: "webDriverBiDi",
			targetId: pages[0]?.id ?? "",
			browserWSEndpoint: "ws://127.0.0.1:1/session",
			safeDir: getPuppeteerDir(),
			timeoutMs: 1_000,
			dialogs: "accept",
		},
	});
	await transport.waitFor(
		(message): message is Extract<WorkerOutbound, { type: "ready" }> => message.type === "ready",
	);
	return { transport };
}

it("routes Firefox worker runs by targetId and keeps dialog policy per alias", async () => {
	const pageA = new ControlledBiDiPage("target-a", "page-a");
	const pageB = new ControlledBiDiPage("target-b", "page-b");
	const { transport } = await initializeBiDiWorker([pageA, pageB]);
	try {
		transport.inbound({
			type: "run",
			id: "run-b",
			name: "alias-b",
			targetId: pageB.id,
			dialogs: "dismiss",
			code: "return await page.url()",
			timeoutMs: 1_000,
			session: { cwd: process.cwd() },
		});
		const result = await transport.waitFor(
			(message): message is Extract<WorkerOutbound, { type: "result" }> =>
				message.type === "result" && message.id === "run-b",
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toBe(pageB.url());
		expect(pageA.evaluations).toEqual([]);

		const dialogB = controlledDialog();
		pageB.emit("dialog", dialogB.dialog);
		await Promise.resolve();
		expect(dialogB.dismissed()).toBe(1);
		expect(dialogB.accepted()).toBe(0);

		transport.inbound({
			type: "select",
			id: "select-a",
			name: "alias-a",
			targetId: pageA.id,
			dialogs: "accept",
			timeoutMs: 1_000,
		});
		const selected = await transport.waitFor(
			(message): message is Extract<WorkerOutbound, { type: "selected" }> =>
				message.type === "selected" && message.id === "select-a",
		);
		expect(selected.info.targetId).toBe(pageA.id);
		const dialogA = controlledDialog();
		pageA.emit("dialog", dialogA.dialog);
		await Promise.resolve();
		expect(dialogA.accepted()).toBe(1);
		expect(dialogA.dismissed()).toBe(0);
	} finally {
		transport.inbound({ type: "close" });
		await transport.waitFor(message => message.type === "closed");
	}
});

it("fails a missing Firefox target instead of falling back to another page", async () => {
	const pageA = new ControlledBiDiPage("target-a", "page-a");
	const pageB = new ControlledBiDiPage("target-b", "page-b");
	const { transport } = await initializeBiDiWorker([pageA, pageB]);
	try {
		transport.inbound({
			type: "run",
			id: "missing-target",
			name: "alias-missing",
			targetId: "target-gone",
			code: "return await page.url()",
			timeoutMs: 1_000,
			session: { cwd: process.cwd() },
		});
		const result = await transport.waitFor(
			(message): message is Extract<WorkerOutbound, { type: "result" }> =>
				message.type === "result" && message.id === "missing-target",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("target-gone");
		expect(pageA.evaluations).toEqual([]);
		expect(pageB.evaluations).toEqual([]);
	} finally {
		transport.inbound({ type: "close" });
		await transport.waitFor(message => message.type === "closed");
	}
});

it("does not acknowledge inline close until a late browser connection has disconnected", async () => {
	const puppeteer = await loadPuppeteerInWorker(getPuppeteerDir());
	const connecting = Promise.withResolvers<void>();
	const connection = Promise.withResolvers<Browser>();
	const disconnecting = Promise.withResolvers<void>();
	const disconnected = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const events: string[] = [];
	const browser = {
		disconnect: async () => {
			events.push("disconnect-start");
			disconnecting.resolve();
			await disconnected.promise;
			events.push("disconnect-end");
		},
	} as unknown as Browser;
	vi.spyOn(puppeteer, "connect").mockImplementation(() => {
		connecting.resolve();
		return connection.promise;
	});
	let receive: ((message: WorkerInbound | WorkerOutbound) => void) | undefined;
	const transport: Transport = {
		send(message) {
			if (message.type === "closed") {
				events.push("closed");
				closed.resolve();
			}
		},
		onMessage(handler) {
			receive = handler;
			return () => {};
		},
		close() {},
	};
	new WorkerCore(transport, false);
	try {
		receive!({
			type: "init",
			payload: {
				mode: "attach",
				protocol: "webDriverBiDi",
				targetId: "",
				browserWSEndpoint: "ws://127.0.0.1:1/session",
				safeDir: getPuppeteerDir(),
				timeoutMs: 1000,
			},
		});
		await connecting.promise;
		receive!({ type: "close" });
		await Bun.sleep(0);
		expect(events).not.toContain("closed");
		connection.resolve(browser);
		await disconnecting.promise;
		expect(events).not.toContain("closed");
		disconnected.resolve();
		await closed.promise;
		expect(events).toEqual(["disconnect-start", "disconnect-end", "closed"]);
	} finally {
		connection.resolve(browser);
		disconnected.resolve();
		receive!({ type: "close" });
		await closed.promise;
	}
});

it("bounds supervisor termination while retaining cleanup of a late connection", async () => {
	const puppeteer = await loadPuppeteerInWorker(getPuppeteerDir());
	const connecting = Promise.withResolvers<void>();
	const connection = Promise.withResolvers<Browser>();
	const disconnected = Promise.withResolvers<void>();
	vi.spyOn(puppeteer, "connect").mockImplementation(() => {
		connecting.resolve();
		return connection.promise;
	});
	const worker = await spawnInlineWorkerForTest();
	const closed = Promise.withResolvers<void>();
	const unsubscribe = worker.onMessage(message => {
		if (message.type === "closed") closed.resolve();
	});
	try {
		worker.send({
			type: "init",
			payload: {
				mode: "attach",
				protocol: "webDriverBiDi",
				targetId: "",
				browserWSEndpoint: "ws://127.0.0.1:1/session",
				safeDir: getPuppeteerDir(),
				timeoutMs: 1000,
			},
		});
		await connecting.promise;
		// The connection remains pending: termination must still finish.
		await worker.terminate();
	} finally {
		connection.resolve({ disconnect: async () => disconnected.resolve() } as unknown as Browser);
		await disconnected.promise;
		await closed.promise;
		unsubscribe();
	}
}, 3000);
