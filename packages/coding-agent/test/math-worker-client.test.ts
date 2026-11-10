import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { MathImageWorkerClient } from "../src/modes/math-image-renderer";
import { MATH_RENDERER_ID, MATH_WORKER_TIMEOUT_MS, type MathWorkerInbound } from "../src/modes/math-worker-protocol";

const request = {
	tex: "x",
	display: false,
	inkHex: "#ffffff",
	cellWidthPx: 9,
	cellHeightPx: 18,
	pixelsPerEx: 9,
	maxWidthPx: 720,
};
const result = { svg: "<svg/>", widthEx: 1, heightEx: 2 };
class TestWorker extends EventTarget {
	static instances: TestWorker[] = [];
	static failConstruction = false;
	messages: MathWorkerInbound[] = [];
	terminated = false;
	failPost = false;
	constructor() {
		super();
		if (TestWorker.failConstruction) throw new Error("construct");
		TestWorker.instances.push(this);
	}
	postMessage(message: MathWorkerInbound) {
		if (this.failPost) throw new Error("post");
		this.messages.push(message);
	}
	terminate() {
		this.terminated = true;
	}
	reply(value: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data: value }));
	}
	handshake(pongFirst = false) {
		const ping = this.messages[0];
		if (pongFirst) this.reply({ ...ping, type: "pong" });
		this.reply({ type: "ready", rendererId: MATH_RENDERER_ID });
		if (!pongFirst) this.reply({ ...ping, type: "pong" });
	}
	finish(error = false) {
		const message = this.messages.at(-1)!;
		this.reply(
			error
				? { ...message, type: "error", error: { name: "TexError", message: "bad formula" } }
				: { ...message, type: "result", result },
		);
	}
}
const NativeWorker = globalThis.Worker;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const timers = new Map<number, { at: number; callback: () => void }>();
let clock = 0;
let timerId = 0;
function advance(ms: number) {
	clock += ms;
	for (const [id, timer] of timers)
		if (timer.at <= clock) {
			timers.delete(id);
			timer.callback();
		}
}
let client: MathImageWorkerClient;
beforeEach(() => {
	TestWorker.instances = [];
	TestWorker.failConstruction = false;
	globalThis.Worker = TestWorker as unknown as typeof Worker;
	clock = 0;
	timers.clear();
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
		// Bun's per-test watchdog uses short deadlines; only worker deadlines are controlled.
		if (ms !== MATH_WORKER_TIMEOUT_MS) return nativeSetTimeout(callback, ms);
		const id = --timerId;
		timers.set(id, { at: clock + ms, callback });
		return id;
	}) as typeof setTimeout);
	vi.spyOn(globalThis, "clearTimeout").mockImplementation(id => {
		if (Number(id) >= 0) {
			nativeClearTimeout(Number(id));
			return;
		}
		timers.delete(Number(id));
	});
	client = new MathImageWorkerClient();
	const render = client.render.bind(client);
	vi.spyOn(client, "render").mockImplementation(request => {
		// Real watchdog is necessary: a removed lifecycle guard can leave a promise unsettled.
		const deadline = Promise.withResolvers<never>();
		const timer = nativeSetTimeout(() => deadline.reject(Error("test render deadline")), 500);
		return Promise.race([render(request), deadline.promise]).finally(() => nativeClearTimeout(timer));
	});
});
afterEach(() => {
	client.dispose();
	globalThis.Worker = NativeWorker;
	vi.restoreAllMocks();
});

describe("math worker client", () => {
	it.each(["error", "close", "message", "startup-timer", "active-timer"])(
		"protects a healthy replacement from old %s",
		async event => {
			client.beginLifecycle();
			const first = client.render(request).catch(error => error);
			const old = TestWorker.instances[0];
			if (event !== "startup-timer") old.handshake();
			advance(100);
			old.dispatchEvent(new Event("error"));
			expect(await first).toBeInstanceOf(Error);
			const next = client.render(request).catch(error => error);
			const replacement = TestWorker.instances[1];
			replacement.handshake();
			if (event === "message") old.reply({ type: "invalid-old-message" });
			else if (event.endsWith("timer")) advance(MATH_WORKER_TIMEOUT_MS - 100);
			else old.dispatchEvent(new Event(event));
			expect(replacement.terminated).toBe(false);
			replacement.finish();
			expect(await next).toEqual(result);
			expect(replacement.terminated).toBe(false);
		},
	);
	it("renews the restart allowance after an exhausted lifecycle", async () => {
		for (let lifecycle = 0; lifecycle < 2; lifecycle++) {
			client.beginLifecycle();
			for (let attempt = 0; attempt < 2; attempt++) {
				const pending = client.render(request).catch(error => error);
				const worker = TestWorker.instances.at(-1)!;
				worker.dispatchEvent(new Event("error"));
				expect(await pending).toBeInstanceOf(Error);
				expect(TestWorker.instances).toHaveLength(lifecycle * 2 + attempt + 1);
			}
			await expect(client.render(request)).rejects.toThrow("exhausted");
			client.terminate();
		}
	});
	it.each([false, true])("is lazy, shares startup and serializes FIFO (pong first %s)", async pongFirst => {
		client.beginLifecycle();
		client.beginLifecycle();
		expect(TestWorker.instances).toHaveLength(0);
		const first = client.render(request);
		const second = client.render(request);
		expect(TestWorker.instances).toHaveLength(1);
		const worker = TestWorker.instances[0];
		expect(worker.messages).toHaveLength(1);
		worker.handshake(pongFirst);
		expect(worker.messages).toHaveLength(2);
		worker.finish();
		await expect(first).resolves.toEqual(result);
		expect(worker.messages).toHaveLength(3);
		worker.finish();
		await expect(second).resolves.toEqual(result);
	});
	it("keeps formula failures local and ignores duplicate, unknown and stale replies", async () => {
		client.beginLifecycle();
		const first = client.render(request);
		const rejection = first.catch(error => error);
		const worker = TestWorker.instances[0];
		worker.handshake();
		worker.finish(true);
		expect(await rejection).toHaveProperty("message", "bad formula");
		const second = client.render(request);
		const active = worker.messages.at(-1)!;
		const poison = { ...result, widthEx: 999 };
		worker.reply({ ...active, type: "result", id: 9999, result: poison });
		worker.reply({ ...active, type: "result", epoch: active.epoch - 1, result: poison });
		worker.finish();
		const third = client.render(request);
		worker.reply({ ...active, type: "result", result: poison });
		worker.finish();
		await expect(third).resolves.toEqual(result);
		await expect(second).resolves.toEqual(result);
		expect(TestWorker.instances).toHaveLength(1);
	});
	it.each(["ready-only", "pong-only", "wrong-id", "wrong-epoch"])("does not complete startup with %s", async mode => {
		client.beginLifecycle();
		const pending = client.render(request);
		const rejection = pending.catch(error => error);
		const worker = TestWorker.instances[0];
		const ping = worker.messages[0];
		if (mode !== "pong-only") worker.reply({ type: "ready", rendererId: MATH_RENDERER_ID });
		if (mode !== "ready-only")
			worker.reply({
				...ping,
				type: "pong",
				...(mode === "wrong-id" ? { id: 9999 } : mode === "wrong-epoch" ? { epoch: ping.epoch + 1 } : {}),
			});
		expect(worker.messages).toHaveLength(1);
		advance(MATH_WORKER_TIMEOUT_MS);
		expect(await rejection).toBeInstanceOf(Error);
		expect(worker.terminated).toBe(true);
	});
	it("ignores late ready announcements while completing active work", async () => {
		client.beginLifecycle();
		const pending = client.render(request);
		const worker = TestWorker.instances[0];
		worker.handshake();
		worker.reply({ type: "ready", rendererId: "wrong" });
		expect(worker.terminated).toBe(false);
		worker.finish();
		await expect(pending).resolves.toEqual(result);
	});
	it.each(["error", "messageerror", "close", "malformed", "identity", "post", "startup", "active"])(
		"settles and bounds later-demand restart after %s",
		async failure => {
			client.beginLifecycle();
			const first = client.render(request);
			const second = client.render(request);
			const rejected = Promise.all([first.catch(error => error), second.catch(error => error)]);
			const worker = TestWorker.instances[0];
			if (failure === "malformed") worker.reply({ type: "nonsense" });
			else if (failure === "identity") worker.reply({ type: "ready", rendererId: "wrong" });
			else if (failure === "startup") advance(MATH_WORKER_TIMEOUT_MS);
			else if (failure === "active") {
				worker.handshake();
				advance(MATH_WORKER_TIMEOUT_MS);
			} else if (failure === "post") {
				worker.failPost = true;
				worker.handshake();
			} else worker.dispatchEvent(new Event(failure));
			for (const error of await rejected) expect(error).toBeInstanceOf(Error);
			expect(worker.terminated).toBe(true);
			const later = client.render(request);
			const laterRejected = later.catch(error => error);
			const replacement = TestWorker.instances[1];
			worker.finish();
			worker.dispatchEvent(new Event("error"));
			replacement.dispatchEvent(new Event("close"));
			expect(await laterRejected).toBeInstanceOf(Error);
			await expect(client.render(request)).rejects.toThrow("exhausted");
			expect(TestWorker.instances).toHaveLength(2);
			client.terminate();
			client.beginLifecycle();
			const fresh = client.render(request);
			const newest = TestWorker.instances[2];
			newest.handshake();
			newest.finish();
			await expect(fresh).resolves.toEqual(result);
		},
	);
	it("counts construction failures against the same restart allowance", async () => {
		client.beginLifecycle();
		TestWorker.failConstruction = true;
		await expect(client.render(request)).rejects.toThrow("construction");
		await expect(client.render(request)).rejects.toThrow("construction");
		TestWorker.failConstruction = false;
		await expect(client.render(request)).rejects.toThrow("exhausted");
		expect(TestWorker.instances).toHaveLength(0);
	});
	it("caps pending work, charges time only on dispatch and cancels unsent requests", async () => {
		client.beginLifecycle();
		const first = client.render(request);
		const worker = TestWorker.instances[0];
		worker.handshake();
		const promises = [first, ...Array.from({ length: 255 }, () => client.render(request))];
		const cancelled = Promise.all(promises.slice(2).map(promise => promise.catch(error => error)));
		const overflow = client.render(request).catch(error => error);
		expect(await overflow).toHaveProperty("message", "Math worker queue is full");
		advance(MATH_WORKER_TIMEOUT_MS - 1);
		worker.finish();
		await promises[0];
		advance(MATH_WORKER_TIMEOUT_MS - 1);
		client.cancelQueued();
		for (const error of await cancelled) expect(error).toHaveProperty("message", "Math rendering cancelled");
		worker.finish();
		await expect(promises[1]).resolves.toEqual(result);
		expect(worker.terminated).toBe(false);
	});
	it("disposes outstanding work and ignores old timers after explicit reinitialization", async () => {
		client.beginLifecycle();
		const pending = client.render(request);
		const rejected = pending.catch(error => error);
		const old = TestWorker.instances[0];
		client.dispose();
		expect(await rejected).toHaveProperty("message", "Math renderer disposed");
		client.beginLifecycle();
		const next = client.render(request);
		const worker = TestWorker.instances[1];
		worker.handshake();
		worker.finish();
		await next;
		old.reply({ type: "ready", rendererId: MATH_RENDERER_ID });
		advance(MATH_WORKER_TIMEOUT_MS);
		expect(worker.terminated).toBe(false);
	});
});
