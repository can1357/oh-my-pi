import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TERN_KIT_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-kit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"browser.tern": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-queries-test" };
const name = "queries";
const namesTab = "queries-role-names";

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, context);
}

async function call(method: string, args: unknown[] = []): Promise<unknown> {
	const result = (await invoke({
		action: "call",
		name,
		chain: [{ method, args }],
	})) as { details?: Record<string, unknown> };
	return result.details?.value;
}

async function run(code: string): Promise<unknown> {
	const result = (await invoke({ action: "run", name, code })) as { details?: Record<string, unknown> };
	return result.details?.value;
}

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	const html = `<!doctype html>
		<style>#styled { color: rgb(1, 2, 3); display: block; } #hidden { display: none; }</style>
		<label for="username">User name</label><input id="username" value="alice">
		<label>Wrapped field <input id="wrapped" value="wrapped-value"></label>
		<input id="aria" aria-label="Secret code" value="1234">
		<input id="placeholder" placeholder="Search records" value="needle">
		<div data-testid="status-card">Ready</div>
		<img alt="Company logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
		<div title="Helpful details">Titled content</div>
		<button id="save-long">Save Changes</button><button id="save-exact">Save</button>
		<div id="copy">Hello <strong>world</strong></div>
		<div class="item">one</div><div class="item">two</div>
		<div id="styled">Styled</div><div id="hidden">Hidden</div>
		<button id="enabled">Enabled</button><button id="disabled" disabled>Disabled</button>
		<input id="checked" type="checkbox" checked><input id="unchecked" type="checkbox">
		<div id="empty"></div>`;
	await invoke({ action: "open", name, url: `data:text/html,${encodeURIComponent(html)}` });
	const namesHtml = `<!doctype html>
		<button title="Open the cart">Cart</button>
		<button><span aria-hidden="true">⚙</span> Settings</button>
		<button><img alt="bogusz's logo" src="data:,"> bogusz</button>
		<button>Sign
			in</button>
		<button>Save<span hidden>!</span></button>
		<button><div>Next</div><div>step</div></button>
		<button><span aria-label="Close dialog">×</span></button>
		<input type="submit">
		<input placeholder="Email">
		<input aria-placeholder="Search records">
		<button><span style="visibility:hidden">x</span>Keep</button>
		<button><span style="visibility:hidden">Hid<b style="visibility:visible">Shown</b></span></button>
		<button>Pick <select><option>Red</option><option selected>Blue</option></select></button>
		<label for="quantity">Size <input value="10"></label><input id="quantity">
		<button aria-labelledby="draft-label"></button><span id="draft-label" style="visibility:hidden"><b>Save draft</b></span>
		<button aria-labelledby="discard-label"></button><span id="discard-label" style="visibility:hidden">Discard<span style="display:none"> draft</span></span>
		<button aria-labelledby="publish-label"></button><span id="publish-label" style="visibility:hidden">Publish<span aria-hidden="true"> now</span></span>
		<button aria-labelledby="archive-label"></button><span id="archive-label" hidden>Archive <b>item</b></span>
		<span id="trash-label">Trash</span>
		<ul role="tree"><li role="treeitem"><input type="checkbox">Node</li><li role="treeitem"><select multiple><option selected>Red</option><option selected>Blue</option></select></li><li role="treeitem"><select aria-label="Palette"><option selected>Green</option></select></li><li role="treeitem"><input type="button" value="Delete" aria-label="Remove"></li><li role="treeitem"><input type="range" aria-valuetext="Medium" value="50"></li><li role="treeitem"><img alt="Delete" aria-labelledby="trash-label" src="data:,"></li></ul>`;
	await invoke({ action: "open", name: namesTab, url: `data:text/html,${encodeURIComponent(namesHtml)}` });
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser semantic selectors and queries", () => {
	it("resolves semantic selector prefixes, role names, and exact role names", async () => {
		expect(await call("value", ["label/User name"])).toBe("alice");
		expect(await call("value", ["label/Wrapped field"])).toBe("wrapped-value");
		expect(await call("value", ["label/Secret code"])).toBe("1234");
		expect(await call("value", ["placeholder/Search records"])).toBe("needle");
		expect(await call("text", ["testid/status-card"])).toBe("Ready");
		expect(await call("attr", ["alt/Company", "alt"])).toBe("Company logo");
		expect(await call("text", ["title/Helpful"])).toBe("Titled content");
		expect(await call("text", ['role/button[name="save"]'])).toBe("Save Changes");
		expect(await call("text", ['role/button[name="save" exact]'])).toBe("Save");
		expect(await call("count", ["role/button"])).toBe(4);
	});

	it.each([
		["a title does not replace the text content", "button", "Cart"],
		["aria-hidden text is left out", "button", "Settings"],
		["an embedded image contributes its alt", "button", "bogusz's logo bogusz"],
		["whitespace collapses", "button", "Sign in"],
		["hidden text is left out", "button", "Save"],
		["block children are separated", "button", "Next step"],
		["a child's aria-label replaces its text", "button", "Close dialog"],
		["a submit input has no value", "button", "Submit"],
		["a textbox is named by its placeholder", "textbox", "Email"],
		["a textbox is named by its aria-placeholder", "textbox", "Search records"],
		["visibility: hidden text is left out", "button", "Keep"],
		["visible text inside a visibility: hidden parent stays", "button", "Shown"],
		["a nested select contributes its selected option", "button", "Pick Blue"],
		["a label contributes another field's value", "textbox", "Size 10"],
		["aria-labelledby points at hidden text", "button", "Save draft"],
		["a checkbox's value is not its text", "treeitem", "Node"],
		["a multi-select contributes every selected option", "treeitem", "Red Blue"],
		["a nested select contributes its value, not its label", "treeitem", "Green"],
		["a nested input button contributes its label", "treeitem", "Remove"],
		["a hidden aria-labelledby target keeps its display: none text", "button", "Discard draft"],
		["a nested range contributes its ARIA value text", "treeitem", "Medium"],
		["a nested image's aria-labelledby wins over its alt", "treeitem", "Trash"],
		["a hidden aria-labelledby target keeps its aria-hidden text", "button", "Publish now"],
		["a display-hidden aria-labelledby target is read whole", "button", "Archive item"],
	])("matches role/ exact names to the name observe() shows when %s", async (_, role, elementName) => {
		const result = (await invoke({
			action: "run",
			name: namesTab,
			code: `const observed = (await tab.observe()).elements.find(entry => entry.role === ${JSON.stringify(role)} && entry.name.trim() === ${JSON.stringify(elementName)});
			return observed && await tab.count(\`role/${role}[name="\${observed.name}" exact]\`);`,
		})) as { details?: { value?: number } };
		expect(result.details?.value).toBe(1);
	});

	it("matches role/ exact names to every name the Tern page kit's observe() shows", async () => {
		const result = (await invoke({
			action: "run",
			name: namesTab,
			// The Tern kit is plain page script embedding the same role/ handler, so it runs on this page too.
			code: `await tab.evaluate(${JSON.stringify(`(function () {\n${TERN_KIT_SOURCE}\n})()`)});
			return await tab.evaluate(() => {
				const kit = globalThis.__ompTernKit;
				return kit.observe({}).elements
					.filter(entry => entry.name && ["button", "textbox", "treeitem"].includes(entry.role))
					.map(entry => [entry.name, kit.count({ engine: "role", query: entry.role + '[name="' + entry.name + '" exact]' })]);
			});`,
		})) as { details?: { value?: [string, number][] } };
		const named = result.details?.value ?? [];
		expect(named.map(([observed]) => observed)).toEqual(
			expect.arrayContaining([
				"Cart",
				"Settings",
				"Keep",
				"Shown",
				"Pick Blue",
				"Size 10",
				"Search records",
				"Save draft",
				"Node",
			]),
		);
		expect(named.filter(([, matched]) => matched !== 1)).toEqual([]);
	});

	it("collapses whitespace in the queried role/ name and skips a title that is not the button's name", async () => {
		const result = (await invoke({
			action: "run",
			name: namesTab,
			code: `return [await tab.count('role/button[name="Sign   in" exact]'), await tab.count('role/button[name="Open the cart" exact]')];`,
		})) as { details?: { value?: number[] } };
		expect(result.details?.value).toEqual([1, 0]);
	});

	it("returns DOM content, values, attributes, counts, boxes, styles, and query state branches", async () => {
		expect(await call("text", ["#copy"])).toBe("Hello world");
		expect(await call("html", ["#copy"])).toBe("Hello <strong>world</strong>");
		expect(await call("value", ["#username"])).toBe("alice");
		expect(await call("value", ["#missing"])).toBeNull();
		expect(await call("attr", ["#username", "id"])).toBe("username");
		expect(await call("attr", ["#username", "missing"])).toBeNull();
		expect(await call("count", [".item"])).toBe(2);
		expect(await call("box", ["#copy"])).toEqual(
			expect.objectContaining({
				x: expect.any(Number),
				y: expect.any(Number),
				width: expect.any(Number),
				height: expect.any(Number),
			}),
		);
		expect(await call("box", ["#missing"])).toBeNull();
		expect(await call("styles", ["#styled", ["color", "display"]])).toEqual({
			color: "rgb(1, 2, 3)",
			display: "block",
		});
		const defaultStyles = (await call("styles", ["#styled"])) as Record<string, string>;
		expect(defaultStyles["font-family"]).toBeTruthy();
		expect(defaultStyles.color).toBe("rgb(1, 2, 3)");
		expect(await call("styles", ["#missing"])).toBeNull();
		expect(await call("isVisible", ["#copy"])).toBe(true);
		expect(await call("isVisible", ["#hidden"])).toBe(false);
		expect(await call("isVisible", ["#missing"])).toBe(false);
		expect(await call("isEnabled", ["#enabled"])).toBe(true);
		expect(await call("isEnabled", ["#disabled"])).toBe(false);
		expect(await call("isEnabled", ["#missing"])).toBe(false);
		expect(await call("isChecked", ["#checked"])).toBe(true);
		expect(await call("isChecked", ["#unchecked"])).toBe(false);
		expect(await call("isChecked", ["#missing"])).toBe(false);
	});

	it("reads the whole page body when text or html gets no selector", async () => {
		const text = (await call("text")) as string;
		expect(text).toContain("Titled content");
		expect(text).toContain("Hello world");
		expect(await call("html")).toContain('<div id="copy">Hello <strong>world</strong></div>');
		expect(await run(`return (await tab.text()).includes("Save Changes")`)).toBe(true);
	});

	it("exposes the same read queries on element handles", async () => {
		expect(
			await run(`const element = await tab.waitFor("#username"); return {
				text: await element.text(), html: await element.html(), value: await element.value(),
				attr: await element.attr("id"), styles: await element.styles(["display"]),
				enabled: await element.isEnabled(), checked: await element.isChecked()
			}`),
		).toEqual({
			text: "",
			html: "",
			value: "alice",
			attr: "username",
			styles: { display: "inline-block" },
			enabled: true,
			checked: false,
		});
	});

	it("waits for delayed body and scoped exact text and reports a named timeout", async () => {
		expect(await call("waitForText", ["Hello world", { timeout: 1_000 }])).toBeUndefined();
		// This integration case deliberately exercises the page's real timer while waitForText polls Chromium.
		expect(
			await run(`await page.evaluate(() => {
				setTimeout(() => {
					const node = document.createElement("div");
					node.textContent = "appeared later";
					document.body.append(node);
				}, 100);
			});
			await tab.waitForText("appeared later", { timeout: 2_000 });
			return true`),
		).toBe(true);
		expect(
			await run(`await page.evaluate(() => {
				setTimeout(() => { document.querySelector("#empty").textContent = "exact scoped text"; }, 100);
			});
			await tab.waitForText("exact scoped text", { selector: "#empty", exact: true, timeout: 2_000 });
			return true`),
		).toBe(true);
		const timeout = (await run(`try {
			await tab.waitForText("never appears", { timeout: 150 });
			return null;
		} catch (error) {
			return { name: error.name, message: error.message };
		}`)) as { name: string; message: string } | null;
		expect(timeout?.name).toBe("ToolError");
		expect(timeout?.message).toContain("tab.waitForText");
	}, 15_000);
});
