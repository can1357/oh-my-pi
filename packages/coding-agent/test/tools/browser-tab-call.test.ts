import { describe, expect, it } from "bun:test";
import { renderTabCall } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-call";

function errorMessage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	throw new Error("Expected callback to throw");
}

describe("renderTabCall", () => {
	it("renders value, presence, and one-hop element calls byte-for-byte", () => {
		expect(renderTabCall([{ method: "click", args: ["text/Go"] }])).toBe('return await tab.click("text/Go");');
		expect(renderTabCall([{ method: "waitFor", args: ["#x", { timeout: 1_000 }] }])).toBe(
			'return (await tab.waitFor("#x", {"timeout":1000})) !== null;',
		);
		expect(
			renderTabCall([
				{ method: "id", args: [5] },
				{ method: "fill", args: ["Ada"] },
			]),
		).toBe('return await (await tab.id(5)).fill("Ada");');
		expect(
			renderTabCall([
				{ method: "ref", args: ["e2"] },
				{ method: "evaluate", args: [{ __omp_fn: "node => node.textContent" }, /not-a-marker/] },
			]),
		).toBe('return await (await tab.ref("e2")).evaluate((node => node.textContent), {});');
		expect(
			renderTabCall([
				{ method: "id", args: [5] },
				{ method: "evaluate", args: ["node => node.textContent"] },
			]),
		).toBe("return await (await tab.id(5)).evaluate((node => node.textContent));");
	});

	it("rejects invalid call chains with actionable errors", () => {
		expect(errorMessage(() => renderTabCall([]))).toBe("Action 'call' requires a non-empty 'chain'.");
		expect(errorMessage(() => renderTabCall([{ method: "notAHelper", args: [] }]))).toContain(
			'Unknown tab helper "notAHelper".',
		);
		expect(errorMessage(() => renderTabCall([{ method: "id", args: [5] }]))).toBe(
			"tab.id() returns an element handle; call a method on it (tab.id(5).click()) or use tab.run(fn).",
		);
		expect(
			errorMessage(() =>
				renderTabCall([
					{ method: "click", args: ["#x"] },
					{ method: "focus", args: [] },
				]),
			),
		).toMatch(/^Only tab\.id\(n\)\/tab\.ref\(id\).* results accept a chained call; got tab\.click\(\)\.$/);
		expect(
			errorMessage(() =>
				renderTabCall([
					{ method: "ref", args: ["e1"] },
					{ method: "remove", args: [] },
				]),
			),
		).toContain('Unknown element method "remove".');
		expect(
			errorMessage(() =>
				renderTabCall([
					{ method: "id", args: [5] },
					{ method: "click", args: [] },
					{ method: "focus", args: [] },
				]),
			),
		).toBe("Call chains support one element-handle hop at most; use tab.run(fn) for longer sequences.");
	});
});
