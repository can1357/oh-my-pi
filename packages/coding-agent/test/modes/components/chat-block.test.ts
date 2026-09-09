import { beforeEach, describe, expect, it } from "bun:test";
import { ChatBlock, type ChatBlockHost } from "@oh-my-pi/pi-coding-agent/modes/components/chat-block";
import type { Component } from "@oh-my-pi/pi-tui";

/** Concrete subclass exposing the protected lifecycle seams for assertions. */
class TestBlock extends ChatBlock {
	mountCount = 0;
	cleanupCount = 0;

	protected override onMount(): void {
		this.mountCount++;
		this.onCleanup(() => {
			this.cleanupCount++;
		});
	}

	/** Public proxy for the protected requestRender. */
	ping(): void {
		this.requestRender();
	}

	/** Public proxy for the protected onCleanup. */
	register(cleanup: () => void): void {
		this.onCleanup(cleanup);
	}
}

describe("ChatBlock lifecycle", () => {
	let renders: number;
	let host: ChatBlockHost;

	beforeEach(() => {
		renders = 0;
		host = {
			requestRender: () => {
				renders++;
			},
		};
	});

	it("runs onMount exactly once; a second mount is a no-op", () => {
		const block = new TestBlock();
		expect(block.mountCount).toBe(0);
		block.mount(host);
		block.mount(host);
		expect(block.mountCount).toBe(1);
	});

	it("is finalized until mounted, live while active, finalized after finish", () => {
		const block = new TestBlock();
		expect(block.isTranscriptBlockFinalized()).toBe(true);
		block.mount(host);
		expect(block.isTranscriptBlockFinalized()).toBe(false);
		block.finish();
		expect(block.isTranscriptBlockFinalized()).toBe(true);
	});

	it("finish runs cleanups once and requests one render", () => {
		const block = new TestBlock();
		block.mount(host);
		const before = renders;
		block.finish();
		expect(block.cleanupCount).toBe(1);
		expect(renders).toBe(before + 1);
		block.finish();
		expect(block.cleanupCount).toBe(1);
	});

	it("dispose runs cleanups once, is idempotent, and finalizes", () => {
		const block = new TestBlock();
		block.mount(host);
		block.dispose();
		expect(block.cleanupCount).toBe(1);
		expect(block.isTranscriptBlockFinalized()).toBe(true);
		block.dispose();
		expect(block.cleanupCount).toBe(1);
	});

	it("finish then dispose does not double-run cleanups", () => {
		const block = new TestBlock();
		block.mount(host);
		block.finish();
		block.dispose();
		expect(block.cleanupCount).toBe(1);
	});

	it("requestRender routes to the host only between mount and dispose", () => {
		const block = new TestBlock();
		block.ping();
		expect(renders).toBe(0);
		block.mount(host);
		block.ping();
		expect(renders).toBe(1);
		block.dispose();
		const after = renders;
		block.ping();
		expect(renders).toBe(after);
	});

	it("onCleanup registered after dispose runs immediately so callers never leak", () => {
		const block = new TestBlock();
		block.mount(host);
		block.dispose();
		let ran = false;
		block.register(() => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	it("dispose propagates to child components", () => {
		const block = new TestBlock();
		let childDisposed = 0;
		const child: Component = {
			render: () => [],
			invalidate: () => {},
			dispose: () => {
				childDisposed++;
			},
		};
		block.addChild(child);
		block.mount(host);
		block.dispose();
		expect(childDisposed).toBe(1);
	});

	it("tears down a timer effect started in onMount when finished", async () => {
		class TimerBlock extends ChatBlock {
			protected override onMount(): void {
				const id = setInterval(() => this.requestRender(), 5);
				this.onCleanup(() => clearInterval(id));
			}
		}
		const block = new TimerBlock();
		block.mount(host);
		await Bun.sleep(25);
		expect(renders).toBeGreaterThan(0); // timer fired while active
		block.finish();
		const settled = renders; // includes finish()'s own render
		await Bun.sleep(25);
		expect(renders).toBe(settled); // interval torn down — no further ticks
	});
});
