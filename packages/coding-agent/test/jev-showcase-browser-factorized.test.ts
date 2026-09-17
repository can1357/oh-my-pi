/**
 * Offline contracts from browser-use/jev-ultrafast tests/test_agent.py.
 * No paid TypeSafe API calls — validates action-space and choice wiring only.
 */
import { describe, expect, it } from "bun:test";
import {
	buildBrowserActionSpace,
	demoBrowserPage,
	resolveBrowserDecision,
	type BrowserActionWire,
} from "../src/jev-showcase/browser-action-space";
import { validateChoiceAnswer, type ChoiceAnswerWire } from "../src/jev-showcase/validate-choice";

function choice(ids: string[], selected: string): ChoiceAnswerWire {
	const probabilities = Object.fromEntries(ids.map(id => [id, id === selected ? 1 : 0]));
	return { choice: selected, confidence: 1, probabilities };
}

describe("jev showcase browser factorized (jev-ultrafast parity)", () => {
	it("indexes one node per element with operation-specific targets", () => {
		const page = demoBrowserPage();
		const { elements, targets, controls } = buildBrowserActionSpace(page.actions);
		expect(elements).toHaveLength(2);
		expect(elements[0]?.operations).toEqual(["TYPE_TEXT", "CLICK"]);
		expect(targets.TYPE_TEXT?.["1"]?.id).toBe("e1");
		expect(targets.CLICK?.["1"]?.id).toBe("e2");
		expect(targets.CLICK?.["2"]?.id).toBe("e3");
		expect("WAIT" in controls).toBe(true);
	});

	for (const mutation of ["unknown", "nan", "missing", "negative", "non_max", "confidence"] as const) {
		it(`rejects invalid choice: ${mutation}`, () => {
			const a = choice(["a", "b"], "a");
			if (mutation === "unknown") a.choice = "invented";
			else if (mutation === "nan") a.probabilities.a = Number.NaN;
			else if (mutation === "missing") delete a.probabilities.b;
			else if (mutation === "negative") a.probabilities.b = -1;
			else if (mutation === "non_max") a.choice = "b";
			else a.confidence = 5;
			expect(() => validateChoiceAnswer(a, new Set(["a", "b"]))).toThrow(/Invalid TypeSafe/);
		});
	}

	it("resolves TYPE_TEXT operation to the fill action id", () => {
		const space = buildBrowserActionSpace(demoBrowserPage().actions);
		const op = validateChoiceAnswer(choice(["TYPE_TEXT", "CLICK"], "TYPE_TEXT"), new Set(["TYPE_TEXT", "CLICK"]));
		const target = validateChoiceAnswer(choice(["1"], "1"), new Set(["1"]));
		expect(resolveBrowserDecision(op.choice, target.choice, space)).toBe("e1");
	});

	it("rejects CLICK on an out-of-head target index", () => {
		const space = buildBrowserActionSpace(demoBrowserPage().actions);
		expect(() => resolveBrowserDecision("CLICK", "999", space)).toThrow(/Invalid TypeSafe/);
	});

	it("carries checkbox state into indexed elements", () => {
		const actions: BrowserActionWire[] = [
			...demoBrowserPage().actions.slice(0, 3),
			{
				id: "toggle",
				kind: "click",
				label: "Free cancellation",
				node: 30,
				role: "checkbox",
				checked: "true",
				selected: false,
			},
		];
		const { elements, targets } = buildBrowserActionSpace(actions);
		const clickTarget = targets.CLICK?.["3"];
		expect(clickTarget?.id).toBe("toggle");
		expect(elements.find(e => e.label === "Free cancellation")?.checked).toBe("true");
	});
});
