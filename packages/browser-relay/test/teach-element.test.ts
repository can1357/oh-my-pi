import { expect, it } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { nameFor, roleFor, selectorFor } from "../extension/teach/element";

it("uses a stable ancestor and distinguishes repeated controls without confusing duplicate ids", () => {
	const { document } = parseHTML(`
		<main id="cart:panel"><button id="duplicate">Remove</button><button id="duplicate">Checkout</button></main>
		<aside><button>Other</button><button>Ignore</button></aside>`);
	const [, target] = document.querySelectorAll("main > button");
	const selector = selectorFor(target, document, value => value.replaceAll(":", "\\:"));
	expect(selector).toBe("#cart\\:panel > button:nth-child(2)");
	if (!selector) throw new Error("Teach did not produce a selector");
	expect(document.querySelectorAll(selector)).toEqual([target]);
});

it("prefers a unique test attribute to a selector that would break when siblings move", () => {
	const { document } = parseHTML(`<button>Cancel</button><button data-testid="checkout">Continue</button>`);
	const [, target] = document.querySelectorAll("button");
	const selector = selectorFor(target, document, value => value);
	expect(selector).toBe('button[data-testid="checkout"]');
	if (!selector) throw new Error("Teach did not produce a selector");
	expect(document.querySelector(selector)).toBe(target);
});

it("prefers referenced ARIA names (including hidden labels) over local text and resolves useful roles", () => {
	const { document } = parseHTML(`
		<span id="region" hidden> Billing </span><span id="leaf" aria-label="History">Ignored</span>
		<button aria-labelledby="region missing leaf" aria-label="Fallback">Visible button</button>
		<select multiple><option>First</option><option>Second</option></select>
		<input type="password" value="must-not-record">
		<a href="/back"> Back    to cart </a>`);
	const [button, select, password, link] = document.querySelectorAll("button, select, input, a");
	const describe = (element: typeof button) =>
		nameFor(element, document, (target, includeHidden) => {
			if (!includeHidden && target.getAttribute("hidden") !== null) return "";
			return target.textContent ?? "";
		});
	expect([roleFor(button), describe(button)]).toEqual(["button", "Billing History"]);
	expect(roleFor(select)).toBe("listbox");
	expect([roleFor(password), describe(password)]).toEqual([undefined, undefined]);
	expect([roleFor(link), describe(link)]).toEqual(["link", "Back to cart"]);
});
