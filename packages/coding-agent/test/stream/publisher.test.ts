import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { TUI, type TuiPaint } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { streamSocketEndpoint } from "../../src/stream/paths";
import { StreamPublisher } from "../../src/stream/publisher";
import { STREAM_LOCAL_PROTO, type StreamSessionFrame } from "../../src/stream/protocol";
import { StreamRedactor } from "../../src/stream/redactor";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("StreamPublisher", () => {
	it("publishes viewport deltas and ordered resets, then detaches when the streamer closes", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stream-publisher-"));
		const endpoint = await streamSocketEndpoint(cwd, { create: true });
		await fs.rm(endpoint, { force: true });
		const frames: StreamSessionFrame[] = [];
		const frameWaiters: Array<{ count: number; resolve: () => void }> = [];
		const waitForFrameCount = (count: number): Promise<void> => {
			if (frames.length >= count) return Promise.resolve();
			const waiter = Promise.withResolvers<void>();
			frameWaiters.push({ count, resolve: waiter.resolve });
			return waiter.promise;
		};
		let peer: net.Socket | undefined;
		const server = net.createServer(socket => {
			peer = socket;
			let input = "";
			socket.on("data", chunk => {
				input += chunk.toString("utf8");
				for (;;) {
					const newline = input.indexOf("\n");
					if (newline < 0) break;
					const line = input.slice(0, newline);
					input = input.slice(newline + 1);
					if (!line) continue;
					const frame = JSON.parse(line) as StreamSessionFrame;
					frames.push(frame);
					for (let index = frameWaiters.length - 1; index >= 0; index--) {
						const waiter = frameWaiters[index]!;
						if (frames.length < waiter.count) continue;
						frameWaiters.splice(index, 1);
						waiter.resolve();
					}
					if (frame.t === "hello") {
						socket.write(
							`${JSON.stringify({ t: "welcome", proto: STREAM_LOCAL_PROTO, channel: "test", url: "test" })}\n`,
						);
					}
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		server.listen(endpoint, () => listening.resolve());
		await listening.promise;
		cleanup.push(async () => {
			peer?.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
			await fs.rm(cwd, { recursive: true, force: true });
		});

		const tui = new TUI(new VirtualTerminal(80, 24));
		let listener: ((paint: TuiPaint) => void) | null = null;
		const originalSetPaintListener = tui.setPaintListener.bind(tui);
		spyOn(tui, "setPaintListener").mockImplementation(next => {
			listener = next;
			originalSetPaintListener(next);
		});
		const statuses: Array<{ viewers: number } | null> = [];
		const detached = Promise.withResolvers<void>();
		const publisher = await StreamPublisher.connect({
			cwd,
			sessionId: "session-1",
			title: "publisher-test",
			tui,
			redactor: await StreamRedactor.load(cwd, ["secret-[a-z]+"]),
			onStatus: status => {
				statuses.push(status);
				if (status === null) detached.resolve();
			},
		});
		expect(publisher).not.toBeNull();
		expect(listener).not.toBeNull();

		const paint = (viewport: readonly string[], options?: { reset?: boolean; history?: readonly string[] }): void => {
			listener?.({
				history: options?.history ?? [],
				viewport,
				reset: options?.reset ?? false,
				alt: false,
				columns: 80,
				rows: 24,
			});
		};
		paint(["\x1b[31msecret-token\x1b[0m", "two", "three", "four"]);
		await waitForFrameCount(2);
		paint(["\x1b[31msecret-token\x1b[0m", "TWO", "three", "four"]);
		await waitForFrameCount(3);
		paint(["ONE", "TWO", "THREE", "FOUR"]);
		await waitForFrameCount(4);
		paint(["new", "screen"], { reset: true, history: ["committed"] });
		await waitForFrameCount(7);

		expect(frames[0]).toEqual({
			t: "hello",
			proto: STREAM_LOCAL_PROTO,
			sessionId: "session-1",
			title: "publisher-test",
			cols: 80,
			rows: 24,
		});
		const payload = frames.filter(frame => frame.t !== "hello");
		expect(payload[0]).toEqual({ t: "viewport", rows: ["••••••", "two", "three", "four"] });
		expect(payload[1]).toEqual({ t: "patch", ops: [[1, "TWO"]], rows: 4 });
		expect(payload[2]).toEqual({ t: "viewport", rows: ["ONE", "TWO", "THREE", "FOUR"] });
		expect(payload.slice(3, 6)).toEqual([
			{ t: "reset" },
			{ t: "history", rows: ["committed"] },
			{ t: "viewport", rows: ["new", "screen"] },
		]);

		peer?.destroy();
		await detached.promise;
		expect(listener).toBeNull();
		expect(statuses).toEqual([{ viewers: 0 }, null]);
		expect(() => tui.renderNow()).not.toThrow();
	});
});
