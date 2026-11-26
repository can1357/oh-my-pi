import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as os from "node:os";
import { isRecord } from "@oh-my-pi/pi-utils";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import { TernTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/tern-tab";
import {
	TernSocketClient,
	type TernTransport,
	type TernTransportEvents,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { type FakeAnswer, frame, jsonPayload } from "./tern-fake-daemon";

const IMAGE = Buffer.from("captured pixels");
const SNAPSHOT = {
	url: "https://example.test/",
	title: "Responsive page",
	viewport: { width: 1000, height: 900, scale: 1 },
	scroll: { x: 0, y: 0, width: 1000, height: 900, scrollWidth: 1000, scrollHeight: 900 },
	truncated: false,
	nodes: [],
};

class RendererTransport implements TernTransport {
	readonly peer = "test renderer";
	readonly waitsForEvents = false;
	readonly requests: Record<string, unknown>[] = [];
	#events: TernTransportEvents | undefined;

	constructor(
		readonly product: "WebKit" | "Tern",
		readonly answer: (op: Record<string, unknown>) => FakeAnswer | Promise<FakeAnswer>,
	) {}

	start(events: TernTransportEvents): void {
		this.#events = events;
		events.open();
	}

	write(bytes: Uint8Array): void {
		const message: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4)));
		if (!isRecord(message)) throw new Error("Invalid request");
		if (message.hello !== undefined) {
			this.#events?.data(frame(jsonPayload({ welcome: { ops: ["browser", "dom", "console", "network"] } })));
			return;
		}
		if (!isRecord(message.browser)) throw new Error("Missing browser request");
		this.requests.push(message.browser);
		void Promise.resolve(this.answer(message.browser)).then(answer => {
			if (answer !== null) this.#events?.data(frame(jsonPayload({ id: message.id, browser: answer })));
		});
	}

	close(): void {
		this.#events?.close();
	}
}

const clients: TernSocketClient[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const client of clients.splice(0)) client.close();
	vi.useRealTimers();
});

function answerNormally(op: Record<string, unknown>): FakeAnswer {
	if (op.op === "events") return { ok: { events: [], next: 0, dropped: 0 } };
	if (op.op === "dom") return { ok: SNAPSHOT };
	if (op.op === "eval") return { ok: { value: true } };
	if (op.op === "capture") return { ok: { data: IMAGE.toString("base64") } };
	return { ok: {} };
}

async function createTab(
	answer: (op: Record<string, unknown>) => FakeAnswer | Promise<FakeAnswer>,
	product: "WebKit" | "Tern" = "WebKit",
): Promise<{ tab: TernTab; transport: RendererTransport; client: TernSocketClient }> {
	const transport = new RendererTransport(product, answer);
	const client = new TernSocketClient({ transport });
	clients.push(client);
	await client.connect();
	const tab = new TernTab({ client, block: 7, name: "test", viewport: { width: 1000, height: 900 } });
	budget(tab);
	return { tab, transport, client };
}

function budget(tab: TernTab, remainingMs = 80, signal = new AbortController().signal): void {
	tab.setRunContext({
		timeoutMs: 45_000,
		deadline: Date.now() + remainingMs + 1_000,
		signal,
		session: { cwd: os.tmpdir() },
		router: InternalUrlRouter.builtins(),
		output: new RunOutput(),
		screenshots: [],
	});
}

describe("WebKit read deadlines and renderer recovery", () => {
	it("captures natively even when page animation-frame evaluation cannot finish", async () => {
		const { tab } = await createTab(op => (op.op === "eval" ? null : answerNormally(op)));
		expect(await tab.captureBytes({ format: "png" })).toEqual(IMAGE);
	});

	it("bounds the whole Tern paint preflight by remaining run time without capturing after timeout", async () => {
		const started = Promise.withResolvers<void>();
		const { tab, transport } = await createTab(op => {
			if (op.op === "eval") {
				started.resolve();
				return null;
			}
			return answerNormally(op);
		}, "Tern");
		const rejected = tab.captureBytes({ format: "png" }).catch((error: unknown) => error);
		await started.promise;
		vi.advanceTimersByTime(80);
		expect(String(await rejected)).toContain("timed out");
		expect(transport.requests.some(op => op.op === "capture")).toBe(false);
	});

	it("shares one screenshot deadline across selector resolution and capture", async () => {
		const node = { ref: "e1-1", tag: "canvas", role: "generic", states: [], rect: [0, 0, 10, 10] };
		const queryStarted = Promise.withResolvers<void>();
		const queryReply = Promise.withResolvers<FakeAnswer>();
		const resolveStarted = Promise.withResolvers<void>();
		const { tab } = await createTab(op => {
			if (op.op === "dom" && op.read === "query") {
				queryStarted.resolve();
				return queryReply.promise;
			}
			if (op.op === "dom" && op.read === "resolve") {
				resolveStarted.resolve();
				return null;
			}
			return answerNormally(op);
		});
		const rejected = tab.captureBytes({ format: "png", selector: "canvas" }).catch((error: unknown) => error);
		await queryStarted.promise;
		vi.advanceTimersByTime(40);
		queryReply.resolve({ ok: { nodes: [node], total: 1 } });
		await resolveStarted.promise;
		vi.advanceTimersByTime(40);
		expect(String(await rejected)).toContain("timed out");
		budget(tab);
		expect(await tab.captureBytes({ format: "png" })).toEqual(IMAGE);
	});

	it("keeps a tab usable when a timed-out read is followed by a successful renderer probe", async () => {
		let stall = true;
		const started = Promise.withResolvers<void>();
		const { tab } = await createTab(op => {
			if (op.op === "dom" && stall) {
				started.resolve();
				return null;
			}
			return answerNormally(op);
		});
		const rejected = tab.observe().catch((error: unknown) => error);
		await started.promise;
		vi.advanceTimersByTime(80);
		expect(String(await rejected)).toContain("timed out");
		stall = false;
		budget(tab);
		expect((await tab.observe()).title).toBe("Responsive page");
	});

	it("quarantines a confirmed native hang, leaves other tabs alone, and permits explicit close/reopen", async () => {
		const closed = new Set<number>();
		const started = Promise.withResolvers<void>();
		const probing = Promise.withResolvers<void>();
		const { tab, client } = await createTab(op => {
			if (op.op === "close" && typeof op.block === "number") closed.add(op.block);
			if (op.block === 7 && (op.op === "dom" || op.op === "eval")) {
				if (op.op === "dom") started.resolve();
				else probing.resolve();
				return null;
			}
			return answerNormally(op);
		});
		const rejected = tab.observe().catch((error: unknown) => error);
		await started.promise;
		vi.advanceTimersByTime(80);
		await probing.promise;
		vi.advanceTimersByTime(500);
		expect(String(await rejected)).toContain("renderer probe timed out");
		budget(tab);
		await expect(tab.captureBytes({ format: "png" })).rejects.toThrow("Close and reopen");
		const other = new TernTab({ client, block: 8, name: "other", viewport: { width: 1000, height: 900 } });
		budget(other);
		expect((await other.observe()).title).toBe("Responsive page");
		await tab.close({ timeoutMs: 100 });
		expect(closed.has(7)).toBe(true);
		const reopened = new TernTab({ client, block: 9, name: "test", viewport: { width: 1000, height: 900 } });
		budget(reopened);
		expect(await reopened.captureBytes({ format: "png" })).toEqual(IMAGE);
	});

	it("does not quarantine a cancelled read or mistake an intentional evaluation timeout for a renderer hang", async () => {
		const started = Promise.withResolvers<void>();
		const evaluating = Promise.withResolvers<void>();
		let stall = true;
		const { tab } = await createTab(op => {
			if (stall && (op.op === "dom" || op.op === "eval")) {
				started.resolve();
				if (op.op === "eval") evaluating.resolve();
				return null;
			}
			return answerNormally(op);
		});
		const controller = new AbortController();
		budget(tab, 500, controller.signal);
		const cancelled = tab.observe();
		await started.promise;
		controller.abort(new Error("User cancelled read"));
		await expect(cancelled).rejects.toThrow("User cancelled read");
		budget(tab, 30);
		const timedOut = tab.evaluate("1 + 1").catch((error: unknown) => error);
		await evaluating.promise;
		vi.advanceTimersByTime(30);
		expect(String(await timedOut)).toContain("timed out");
		stall = false;
		budget(tab);
		expect((await tab.observe()).title).toBe("Responsive page");
	});
});
