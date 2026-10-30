import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { buildStealthInjectionScriptForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

// Minimal canvas DOM: one cached 2d context per canvas, like Chromium.
const CANVAS_DOM = `
globalThis.window = globalThis;
globalThis.document = { head: null, documentElement: null };
globalThis.drawn = [];
class CanvasRenderingContext2D {
	fillText(text, x, y) { drawn.push({ text, x, y }); }
}
class HTMLCanvasElement {
	getContext(type) {
		if (type !== "2d") return null;
		return (this.ctx ??= new CanvasRenderingContext2D());
	}
}
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
globalThis.HTMLCanvasElement = HTMLCanvasElement;
`;

/** Runs `body` in a fresh realm after the shipped stealth bootstrap has been injected. */
function runPatched(body: string): unknown {
	const context = vm.createContext({});
	vm.runInContext(CANVAS_DOM, context);
	vm.runInContext(buildStealthInjectionScriptForTest(), context);
	return vm.runInContext(`(() => {${body}})()`, context);
}

describe("stealth fonts canvas patch", () => {
	it("keeps fillText stable and drawable when the same context is reacquired (#16879)", () => {
		const result = runPatched(`
			const canvas = new HTMLCanvasElement();
			const ctx = canvas.getContext("2d");
			const first = ctx.fillText;
			for (let i = 0; i < 100000; i++) canvas.getContext("2d");
			ctx.fillText("test", 10, 20);
			return { stable: first === ctx.fillText, drawn };
		`) as { stable: boolean; drawn: { text: string; x: number; y: number }[] };

		expect(result.stable).toBe(true);
		expect(result.drawn).toHaveLength(1);
		expect(result.drawn[0].text).toBe("test");
		expect(Math.abs(result.drawn[0].x - 10)).toBeLessThanOrEqual(0.01);
		expect(Math.abs(result.drawn[0].y - 20)).toBeLessThanOrEqual(0.01);
	});
});
