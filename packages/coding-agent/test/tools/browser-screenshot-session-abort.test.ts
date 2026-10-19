import { describe, expect, it } from "bun:test";
import { whileDrawing } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import type { CDPSession, Page } from "puppeteer-core";

describe("whileDrawing", () => {
	it("stops waiting for a DevTools session at the abort and detaches it once it attaches", async () => {
		const attach = Promise.withResolvers<CDPSession>();
		const detached = Promise.withResolvers<void>();
		const session = {
			send: async () => ({}),
			detach: async () => detached.resolve(),
		} as unknown as CDPSession;
		const page = { createCDPSession: () => attach.promise } as unknown as Page;
		const controller = new AbortController();
		let captured = false;
		const settled = whileDrawing(page, controller.signal, async () => {
			captured = true;
		}).then(
			() => "captured",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		controller.abort(new Error("screenshot deadline"));
		// Everything after the abort runs as microtasks; one macrotask turn drains them.
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		expect(Bun.peek.status(settled)).toBe("fulfilled");
		expect(await settled).toContain("screenshot deadline");
		expect(captured).toBe(false);
		attach.resolve(session);
		await detached.promise;
	});
});
