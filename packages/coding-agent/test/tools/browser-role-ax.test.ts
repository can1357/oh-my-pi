import { describe, expect, it } from "bun:test";
import { ensureChromiumExecutable, loadPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { registerSemanticQueryHandlers } from "@oh-my-pi/pi-coding-agent/tools/browser/query-handlers";
import { TERN_KIT_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-kit";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const available = await chromiumAvailable();

/** The ids of the elements a selector matches in the page. */
async function ids(page: Page, selector: string): Promise<string[]> {
	return await page.$$eval(selector, elements => elements.map(element => element.id));
}

describe.skipIf(!available)("Chromium role/ selectors through the accessibility tree", () => {
	it("answer in a background tab, inside a scope, and inside a frame", async () => {
		const puppeteer = await loadPuppeteer();
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			// A tab opened in the background is hidden: Chrome renders nothing for it until it is shown.
			const page = await browser.newPage({ background: true });
			await (await browser.newPage()).bringToFront();
			await page.setContent(`<!doctype html>
				<button id="outside">Outside</button>
				<nav id="footer" aria-label="Footer"><a id="about" href="#about">About</a><a id="help" href="#help">Help</a></nav>
				<a id="home" href="#home">Home</a>
				<iframe srcdoc="<button id=framed>Framed</button>"></iframe>`);
			expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
			expect(await ids(page, "role/button")).toEqual(["outside"]);

			const footer = (await page.$('role/navigation[name="Footer" exact]'))!;
			expect(await footer.$$eval("role/link", elements => elements.map(element => element.id))).toEqual([
				"about",
				"help",
			]);
			// The scope itself is not one of its matches.
			expect(await footer.$$("role/navigation")).toEqual([]);

			const frame = page.frames().find(candidate => candidate !== page.mainFrame())!;
			await frame.waitForSelector('role/button[name="Framed" exact]', { timeout: 10_000 });
			expect(await frame.$$eval("role/button", elements => elements.map(element => element.id))).toEqual(["framed"]);
		} finally {
			await browser.close();
		}
	}, 60_000);

	it("refuses role inside a P-selector, where the accessibility tree cannot be asked", async () => {
		const puppeteer = await loadPuppeteer();
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent("<main><button>Save</button></main>");
			expect(String(await page.$$("main ::-p-role(button)").catch(error => error))).toContain(
				"role/ selectors must be the whole selector",
			);
		} finally {
			await browser.close();
		}
	});

	it("finds every element Chrome's full accessibility tree gives a role, across tags and contexts", async () => {
		const puppeteer = await loadPuppeteer();
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		const tags =
			"a abbr address area article aside audio b blockquote button canvas caption code datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i iframe img ins label legend li main mark menu meter nav object ol optgroup option output p pre progress ruby s search section select span strong sub summary sup table tbody td textarea tfoot th thead time tr ul video math svg".split(
				" ",
			);
		const inputs =
			"button checkbox color date datetime-local email file image month number password radio range reset search submit tel text time url week".split(
				" ",
			);
		const elements =
			tags
				.flatMap(tag => [
					`<${tag}>x</${tag}>`,
					`<${tag} href="#" tabindex="0" aria-label="L" alt="A" src="data:," open>x</${tag}>`,
					`<${tag} alt="">x</${tag}>`,
				])
				.join("") +
			inputs.map(type => `<input type="${type}"><input type="${type}" list="options" aria-label="L">`).join("") +
			'<datalist id="options"><option>o</option></datalist>';
		// Contexts that change an element's role: tables and grids, lists and menus, landmarks and sections.
		const contexts = [
			(content: string) => content,
			(content: string) =>
				`<table><thead><tr><th>h</th><th scope="row">r</th></tr></thead><tbody><tr><th>rh</th><td>${content}</td></tr></tbody></table>`,
			(content: string) => `<table role="grid"><tr><th>h</th><td>${content}</td></tr></table>`,
			(content: string) =>
				`<ul><li>${content}</li></ul><div role="listbox">${content}</div><select><optgroup label="g"><option>o</option></optgroup></select>`,
			(content: string) =>
				`<section aria-label="S">${content}<header>h</header><footer>f</footer><aside>a</aside></section><article><header>h</header></article><main><footer>f</footer></main>`,
			(content: string) =>
				`<form aria-label="F">${content}</form><fieldset><legend>l</legend>${content}</fieldset><details><summary>s</summary></details><figure><figcaption>c</figcaption></figure><label>l <input></label>`,
			(content: string) =>
				`<svg width="9" height="9"><title>T</title></svg><svg role="img" aria-label="i"></svg><div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(content)};</script>`,
		];
		try {
			const page = await browser.newPage();
			// Puppeteer's own session for the page: the handles' object ids belong to it.
			const cdp = page.mainFrame().client;
			const mismatches = [];
			for (const context of contexts) {
				await page.setContent(`<!doctype html><body>${context(elements)}</body>`);
				// The elements a selector can reach: the page and its open shadow roots (not the browser's own controls).
				const reachable = await page.evaluateHandle(() => {
					const found: unknown[] = [];
					const visit = (scope: { querySelectorAll(selector: string): Iterable<{ shadowRoot: never }> }) => {
						for (const element of scope.querySelectorAll("*")) {
							found.push(element);
							if (element.shadowRoot) visit(element.shadowRoot);
						}
					};
					visit(document as never);
					return found;
				});
				const backendIdsOf = async (handles: Iterable<{ remoteObject(): { objectId?: string } }>) =>
					await Promise.all(
						[...handles].map(
							async handle =>
								(await cdp.send("DOM.describeNode", { objectId: handle.remoteObject().objectId })).node
									.backendNodeId,
						),
					);
				const reachableIds = new Set(
					await backendIdsOf([...(await reachable.getProperties()).values()].filter(handle => handle.asElement())),
				);
				const expected = new Map<string, number[]>();
				for (const node of (await cdp.send("Accessibility.getFullAXTree", {})).nodes) {
					if (node.ignored || !node.backendDOMNodeId || !reachableIds.has(node.backendDOMNodeId)) continue;
					const role = String(node.role?.value).toLowerCase();
					expected.set(role, [...(expected.get(role) ?? []), node.backendDOMNodeId]);
				}
				for (const [role, ids] of expected) {
					const actual = await backendIdsOf(await page.$$(`role/${role}`));
					if (JSON.stringify(actual.sort()) !== JSON.stringify(ids.sort())) {
						mismatches.push({
							context: contexts.indexOf(context),
							role,
							expected: ids.length,
							actual: actual.length,
						});
					}
				}
			}
			expect(mismatches).toEqual([]);
		} finally {
			await browser.close();
		}
	}, 120_000);
});

/** Observed role and name of each `observe({ includeAll: true })` entry the kit's own role/ engine cannot reselect. */
function unreselectable(): { role: string; name: string }[] {
	// The kit is installed in this page's realm before this runs; its tokens mark elements with this attribute.
	const kit = (globalThis as unknown as { __ompTernKit: TernKitProbe }).__ompTernKit;
	const misses: { role: string; name: string }[] = [];
	for (const entry of kit.observe({ includeAll: true }).elements) {
		if (!entry.name) continue;
		const quote = entry.name.includes('"') ? "'" : '"';
		const own = kit.mark({ engine: "id", id: entry.id });
		const tokens = kit.markAll({ engine: "role", query: `${entry.role}[name=${quote}${entry.name}${quote} exact]` });
		const marked = (
			globalThis as unknown as { document: { querySelector(selector: string): TernElement | null } }
		).document
			.querySelector(`[data-omp-tern-handle~="${own}"]`)
			?.getAttribute("data-omp-tern-handle")
			?.split(/\s+/);
		if (!tokens.some(token => marked?.includes(token))) misses.push({ role: entry.role, name: entry.name });
	}
	return misses;
}

interface TernElement {
	getAttribute(name: string): string | null;
}

interface TernKitProbe {
	observe(options: { includeAll: boolean }): { elements: { id: number; role: string; name?: string }[] };
	mark(selector: unknown): string;
	markAll(selector: unknown): string[];
}

describe.skipIf(!available)("Tern kit roles and names", () => {
	it("reports names in observe() that its role/ selector finds again, Codex's #17895 cases included", async () => {
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			// The kit is plain page script, so Chrome hosts it as WKWebView does.
			await page.setContent(`<!doctype html>
				<address aria-label="Office">1 Main Street</address>
				<hgroup aria-label="Masthead"><h1>Paper</h1><p>Daily</p></hgroup>
				<section aria-labelledby="quarterly"><p>Body</p></section>
				<table id="quarterly"><caption>Quarterly</caption><tr><td>Profit</td></tr></table>
				<section aria-labelledby="contents"><p>Body</p></section>
				<span id="contents" style="display: contents">Visible <b hidden>Hidden</b></span>
				<table><caption aria-label="Quarterly totals">Visible caption</caption><tr><td>Total</td></tr></table>
				<fieldset><legend>Shipping</legend><label>Street <input></label><label for="zip">Zip</label><label for="zip">code</label><input id="zip"></fieldset>
				<select aria-label="Fruit"><optgroup label="Citrus"><option>Lemon</option></optgroup></select>
				<nav aria-label="Main"><a href="#a">About</a><a>No link</a></nav>
				<article><header aria-label="Story head">Head</header><aside aria-label="Related">Side</aside></article>
				<dl><dt>Term</dt><dd>Definition</dd></dl><dfn>Word</dfn>
				<details><summary>More</summary>Folded</details>
				<div contenteditable="true" aria-label="Notes"></div>
				<input type="search" list="suggestions" aria-label="Find"><datalist id="suggestions"><option>x</option></datalist>
				<input type="color" aria-label="Tint"><input type="image" alt="Go" src="data:,">
				<button><img alt="Gear" src="data:,"> Settings</button>`);
			await page.evaluate(`(function () {\n${TERN_KIT_SOURCE}\n})()`);
			const observed = await page.evaluate(() => {
				const kit = (globalThis as unknown as { __ompTernKit: TernKitProbe }).__ompTernKit;
				return kit.observe({ includeAll: true }).elements.map(entry => `${entry.role} ${entry.name ?? ""}`);
			});
			// Codex's findings on #17895 (r4462930387, r4463081158, r4463081163, r4463081171).
			expect(observed).toEqual(
				expect.arrayContaining([
					"group Office",
					"group Masthead",
					"region Quarterly",
					"region Visible",
					"table Quarterly totals",
				]),
			);
			expect(await page.evaluate(unreselectable)).toEqual([]);
		} finally {
			await browser.close();
		}
	});
});
