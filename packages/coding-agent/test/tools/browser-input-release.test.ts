import { describe, expect, test } from "bun:test";
import { clickAt, pressKey } from "@oh-my-pi/pi-coding-agent/tools/browser/interactions";
import type { Page } from "puppeteer-core";

describe("pressKey releases every key it pressed", () => {
	/** A page whose keyboard records what is sent; `up` decides how each release settles. */
	function recordingPage(up: (key: string) => Promise<void>): { page: Page; sent: string[] } {
		const sent: string[] = [];
		const keyboard = {
			down: async (key: string) => {
				sent.push(`down:${key}`);
			},
			up: (key: string) => {
				sent.push(`up:${key}`);
				return up(key);
			},
		};
		return { page: { keyboard } as unknown as Page, sent };
	}

	test("a release that fails does not keep the modifier held", async () => {
		const { page, sent } = recordingPage(async key => {
			if (key === "a") throw new Error("Session closed");
		});
		const error = await pressKey(page, "Shift+a").then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(sent).toEqual(["down:Shift", "down:a", "up:a", "up:Shift"]);
		expect(error instanceof Error ? error.message : error).toBe("Session closed");
	});

	test("an abort while a release is unanswered sends the remaining releases at once", async () => {
		const pending = Promise.withResolvers<void>();
		const { page, sent } = recordingPage(key => (key === "a" ? pending.promise : Promise.resolve()));
		const controller = new AbortController();
		const pressing = pressKey(page, "Shift+a", undefined, controller.signal);
		for (let i = 0; i < 10 && !sent.includes("up:a"); i++) await Promise.resolve();
		expect(sent).toEqual(["down:Shift", "down:a", "up:a"]);
		controller.abort();
		await pressing;
		expect(sent).toEqual(["down:Shift", "down:a", "up:a", "up:Shift"]);
	});
});

describe("clickAt on a tab that draws no frames", () => {
	test("presses without waiting for the pointer move, which Chrome answers only once a press flushes it", async () => {
		const sent: string[] = [];
		const moved = Promise.withResolvers<void>();
		const mouse = {
			move: (x: number, y: number) => {
				sent.push(`move:${x},${y}`);
				return moved.promise;
			},
			down: async () => {
				sent.push("down");
				moved.resolve();
			},
			up: async () => {
				sent.push("up");
			},
		};
		await clickAt({ mouse } as unknown as Page, 80, 40);
		expect(sent).toEqual(["move:80,40", "down", "up"]);
	});
});
