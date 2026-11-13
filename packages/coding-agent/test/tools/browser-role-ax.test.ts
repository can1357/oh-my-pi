import { describe, expect, it, jest, spyOn } from "bun:test";
import { ensureChromiumExecutable, loadPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { isNavigatedContextError } from "@oh-my-pi/pi-coding-agent/tools/browser/navigation";
import { registerSemanticQueryHandlers } from "@oh-my-pi/pi-coding-agent/tools/browser/query-handlers";
import { TERN_KIT_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-kit";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";
import { rejectionOf } from "../helpers/rejection";

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
			await page.setContent(`<!doctype html><title>Role fixture</title>
				<button id="outside">Outside</button>
				<nav id="footer" aria-label="Footer"><a id="about" href="#about">About</a><a id="help" href="#help">Help</a></nav>
				<a id="home" href="#home">Home</a>
				<iframe srcdoc="<button id=framed>Framed</button>"></iframe>`);
			expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
			expect(await ids(page, "role/button")).toEqual(["outside"]);
			const documentHandle = await page.$('role/RootWebArea[name="Role fixture" exact]');
			expect(await documentHandle?.evaluate(node => node.nodeType)).toBe(9);
			await documentHandle?.dispose();

			const footer = (await page.$('role/navigation[name="Footer" exact]'))!;
			expect(await footer.$$eval("role/link", elements => elements.map(element => element.id))).toEqual([
				"about",
				"help",
			]);
			// The scope itself is not one of its matches.
			expect(await footer.$$("role/navigation")).toEqual([]);
			expect(await footer.$$("role/RootWebArea")).toEqual([]);
			// A wait rooted at an element searches below it.
			expect(
				await (
					await footer.waitForSelector('role/link[name="Help"]', { timeout: 10_000 })
				)?.evaluate(link => link.id),
			).toBe("help");

			const frame = page.frames().find(candidate => candidate !== page.mainFrame())!;
			await frame.waitForSelector('role/button[name="Framed" exact]', { timeout: 10_000 });
			expect(await frame.$$eval("role/button", elements => elements.map(element => element.id))).toEqual(["framed"]);
		} finally {
			await browser.close();
		}
	});

	it("treats a document role as visible while a hidden wait remains pending until aborted", async () => {
		const puppeteer = await loadPuppeteer();
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent("<title>Root wait</title>");
			const root = await page.waitForSelector("role/RootWebArea", { visible: true });
			expect(await root?.evaluate(node => node.nodeType)).toBe(9);
			await root?.dispose();
			const controller = new AbortController();
			const checked = Promise.withResolvers<void>();
			const send = page.mainFrame().client.send.bind(page.mainFrame().client);
			let probes = 0;
			const probe = spyOn(page.mainFrame().client, "send").mockImplementation(async (method, ...args) => {
				const result = await send(method, ...args);
				if (method === "Accessibility.getPartialAXTree" && ++probes === 2) checked.resolve();
				return result;
			});
			try {
				const reason = new Error("stop hidden root wait");
				const pending = rejectionOf(
					page.waitForSelector("role/RootWebArea", { hidden: true, signal: controller.signal }),
				);
				await Promise.race([
					checked.promise,
					pending.then(error => {
						throw error;
					}),
				]);
				controller.abort(reason);
				expect(await pending).toBe(reason);
			} finally {
				probe.mockRestore();
			}
		} finally {
			await browser.close();
		}
	});

	it.each(["timeout", "abort"] as const)("ends a role wait during a pending AX probe on %s", async mode => {
		const puppeteer = await loadPuppeteer();
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const disposed = Promise.withResolvers<void>();
		let restoreProbe: (() => void) | undefined;
		try {
			const page = await browser.newPage();
			await page.setContent("<button>Save</button>");
			const client = page.mainFrame().client;
			const send = client.send.bind(client);
			let objectId: unknown;
			const probe = spyOn(client, "send").mockImplementation(async (method, ...args) => {
				const params = args[0];
				if (method === "Accessibility.getPartialAXTree" && params && "objectId" in params) {
					objectId = params.objectId;
					started.resolve();
					await release.promise;
				}
				const result = await send(method, ...args);
				if (method === "Runtime.releaseObject" && params && "objectId" in params && params.objectId === objectId)
					disposed.resolve();
				return result;
			});
			restoreProbe = () => probe.mockRestore();
			const controller = new AbortController();
			if (mode === "timeout") jest.useFakeTimers();
			const rejection = rejectionOf(
				page.waitForSelector("role/button", { timeout: mode === "timeout" ? 1_000 : 0, signal: controller.signal }),
			);
			await started.promise;
			if (mode === "timeout") jest.advanceTimersByTime(1_000);
			else controller.abort(new Error("Stopped"));
			expect(await rejection).toMatchObject({ name: mode === "timeout" ? "TimeoutError" : "AbortError" });
			release.resolve();
			await disposed.promise;
		} finally {
			release.resolve();
			jest.useRealTimers();
			restoreProbe?.();
			await browser.close();
		}
	});

	it("keeps waiting through a navigation that replaces the document", async () => {
		const puppeteer = await loadPuppeteer();
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent("<h1>First</h1>");
			const waiting = page.waitForSelector('role/heading[name="Next" exact]', { timeout: 10_000 });
			await page.goto("data:text/html,<h1>Next</h1>");
			const heading = await waiting;
			expect(await page.evaluate(element => element?.textContent, heading)).toBe("Next");
			await heading?.dispose();
		} finally {
			await browser.close();
		}
	});

	it("propagates a navigation that invalidates an accessibility probe batch", async () => {
		const puppeteer = await loadPuppeteer();
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent("<button>Before</button>");
			const client = page.mainFrame().client;
			const send = client.send.bind(client);
			let navigated = false;
			const probe = spyOn(client, "send").mockImplementation(async (method, ...args) => {
				if (method === "Accessibility.getPartialAXTree" && !navigated) {
					navigated = true;
					await page.goto("data:text/html,<button>After</button>");
				}
				return await send(method, ...args);
			});
			try {
				expect(isNavigatedContextError(await rejectionOf(page.$$("role/button")))).toBe(true);
			} finally {
				probe.mockRestore();
			}
			expect(await ids(page, 'role/button[name="After" exact]')).toHaveLength(1);
		} finally {
			await browser.close();
		}
	});

	it("finds a match past the first round trip, layout tables as tables, and presentational elements as none", async () => {
		const puppeteer = await loadPuppeteer();
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			const buttons = Array.from({ length: 100 }, (_, index) => `<button id="b${index}">b${index}</button>`).join(
				"",
			);
			await page.setContent(`<!doctype html>${buttons}
				<table id="layout"><tr id="layout-row"><td id="layout-cell">x</td></tr></table>
				<div id="none" role="none">Plain</div><img id="decorative" alt="" src="data:,">`);
			expect(await (await page.$('role/button[name="b99" exact]'))?.evaluate(button => button.id)).toBe("b99");
			// Chrome reports this table as LayoutTable; HTML and the reader call it a table.
			expect(await ids(page, "role/table")).toEqual(["layout"]);
			expect(await ids(page, "role/row")).toEqual(["layout-row"]);
			expect(await ids(page, "role/cell")).toEqual(["layout-cell"]);
			expect(await ids(page, "role/presentation")).toEqual(["none", "decorative"]);
		} finally {
			await browser.close();
		}
	});

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
			"a abbr address area article aside audio b blockquote br button canvas caption code datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i iframe img ins label legend li main mark menu meter nav object ol optgroup option output p pre progress ruby s search section select span strong sub summary sup table tbody td textarea tfoot th thead time tr ul video math svg".split(
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
			'<datalist id="options"><option>o</option></datalist>' +
			// An implicit editing host is generic in Chrome, not the textbox that Tern's rules infer.
			'<div contenteditable="true" aria-label="Notes">Draft</div>' +
			// Chrome exposes the annotation as Ruby's description and ignores the native rt node.
			"<ruby>漢<rt>かん</rt></ruby>";
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
				`<svg width="40" height="40"><title>T</title><image href="data:," width="5" height="5"><title>P</title></image><g><title>G</title><circle r="3"></circle></g><circle r="4"><title>C</title></circle><path d="M0 0L5 5"><title>Pa</title></path><use href="#nothing"><title>U</title></use><text y="10">Tx</text><a href="#"><text>L</text></a></svg>` +
				`<math><mfrac><mi>x</mi><mn>2</mn></mfrac><msqrt><mi>y</mi></msqrt></math>` +
				`<svg role="img" aria-label="i"></svg><x-internal></x-internal><div id="host"></div><script>
				if (!customElements.get("x-internal")) customElements.define("x-internal", class extends HTMLElement { constructor() { super(); this.attachInternals().role = "button"; } });
				document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(content)};</script>`,
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
					type Scope = { querySelectorAll(selector: string): Iterable<{ shadowRoot: Scope | null }> };
					const found: unknown[] = [];
					const visit = (scope: Scope) => {
						for (const element of scope.querySelectorAll("*")) {
							found.push(element);
							if (element.shadowRoot) visit(element.shadowRoot);
						}
					};
					visit((globalThis as unknown as { document: Scope }).document);
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
				// Chrome's layout tables are tables to role/ too.
				const reportedAs: Record<string, string> = {
					table: "layouttable",
					row: "layouttablerow",
					cell: "layouttablecell",
				};
				for (const [role, own] of expected) {
					const ids = [...own, ...(expected.get(reportedAs[role] ?? "") ?? [])];
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
	});
});

/** Observed role and name of each `observe({ includeAll: true })` entry the kit's own role/ engine cannot reselect. */
function unreselectable(): { role: string; name: string }[] {
	// The kit is installed in this page's realm before this runs; its tokens mark elements with this attribute.
	const kit = (globalThis as unknown as { __ompTernKit: TernKitProbe }).__ompTernKit;
	const misses: { role: string; name: string }[] = [];
	for (const entry of kit.observe({ includeAll: true }).elements) {
		// Text entries name no element a role/ selector can ask for.
		if (!entry.name || entry.role === "StaticText") continue;
		const quote = entry.name.includes('"') ? "'" : '"';
		const own = kit.mark({ engine: "id", id: entry.id });
		const tokens = kit.markAll({ engine: "role", query: `${entry.role}[name=${quote}${entry.name}${quote} exact]` });
		if (
			!tokens.some(
				token =>
					kit.count({
						engine: "pierce",
						query: `[data-omp-tern-handle~="${own}"][data-omp-tern-handle~="${token}"]`,
					}) > 0,
			)
		)
			misses.push({ role: entry.role, name: entry.name });
	}
	return misses;
}

interface TernKitProbe {
	observe(options: { includeAll: boolean }): {
		elements: { id: number; role: string; name?: string; value?: string | number; description?: string }[];
	};
	count(selector: unknown): number;
	mark(selector: unknown): string;
	markAll(selector: unknown): string[];
}

describe.skipIf(!available)("Tern kit roles and names", () => {
	it("masks filled password values in serialized kit observations without changing text values", async () => {
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent(`<input id="pw" type="password" aria-label="Password">
				<input aria-label="Username">
				<input aria-labelledby="pw">
				<input aria-label="Described" aria-describedby="pw">
				<button>Reveal <input type="password" value="SENTINEL-pw-123"></button>`);
			await page.locator("#pw").fill("SENTINEL-pw-123");
			await page.locator('input[aria-label="Username"]').fill("plain-text");
			await page.evaluate(`(function () {\n${TERN_KIT_SOURCE}\n})()`);
			const observed = await page.evaluate(() => {
				// The serialized kit installs this object in the page's realm.
				const pageGlobal = globalThis as unknown as { __ompTernKit: TernKitProbe };
				const kit = pageGlobal.__ompTernKit;
				return kit.observe({ includeAll: true });
			});
			expect(observed.elements).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "textbox", name: "Password", value: "•".repeat(15) }),
					expect.objectContaining({ role: "textbox", name: "Username", value: "plain-text" }),
					expect.objectContaining({ role: "textbox", name: "•".repeat(15) }),
					expect.objectContaining({ role: "textbox", name: "Described", description: "•".repeat(15) }),
					expect.objectContaining({ role: "button", name: "Reveal " + "•".repeat(15) }),
				]),
			);
			expect(JSON.stringify(observed)).not.toContain("SENTINEL-pw-123");
		} finally {
			await browser.close();
		}
	});

	it("keeps DOM roles and names independent of a Turkish default locale", async () => {
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent(
				'<input type="image" alt="Send"><input aria-label="Address"><span role="LINK">Home</span>',
			);
			await page.evaluate(() => {
				// CDP's locale override changes Intl but not V8's default string casing.
				const lower = String.prototype.toLocaleLowerCase;
				String.prototype.toLocaleLowerCase = function (locales) {
					return lower.call(this, locales ?? "tr");
				};
			});
			expect(await page.evaluate(() => "INPUT".toLocaleLowerCase())).toBe("ınput");
			await page.evaluate(`(function () {\n${TERN_KIT_SOURCE}\n})()`);
			expect(
				await page.evaluate(() => {
					const kit = (globalThis as unknown as { __ompTernKit: TernKitProbe }).__ompTernKit;
					return [
						kit.observe({ includeAll: true }).elements.map(entry => `${entry.role} ${entry.name ?? ""}`),
						kit.count({ engine: "role", query: 'BUTTON[name="Send" exact]' }),
						kit.count({ engine: "role", query: 'textbox[name="Address" exact]' }),
						kit.count({ engine: "role", query: 'LINK[name="Home" exact]' }),
					];
				}),
			).toEqual([expect.arrayContaining(["button Send", "textbox Address", "link Home"]), 1, 1, 1]);
		} finally {
			await browser.close();
		}
	});

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
				<button><img alt="Gear" src="data:,"> Settings</button>
				<input type="date" aria-label="When">
				<a href="#docs"><x-label>Docs</x-label></a>
				<x-save role="button"></x-save>
				<article><x-scoped></x-scoped></article>
				<script>
					customElements.define("x-label", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<span><slot></slot></span>"; } });
					customElements.define("x-save", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<span>Save</span>"; } });
					customElements.define("x-scoped", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<header aria-label="Scoped head">Head</header><footer aria-label="Scoped foot">Foot</footer><aside>Scoped aside</aside>'; } });
				</script>`);
			await page.evaluate(`(function () {\n${TERN_KIT_SOURCE}\n})()`);
			const [observed, interactive, docsLinks, complementary] = await page.evaluate(() => {
				const kit = (globalThis as unknown as { __ompTernKit: TernKitProbe }).__ompTernKit;
				const entries = (includeAll: boolean) =>
					kit.observe({ includeAll }).elements.map(entry => `${entry.role} ${entry.name ?? ""}`);
				return [
					entries(true),
					entries(false),
					kit.count({ engine: "role", query: 'link[name="Docs" exact]' }),
					kit.count({ engine: "role", query: "complementary" }),
				] as const;
			});
			// Codex's findings on #17895 (r4462930387, r4463081158, r4463081163, r4463081171).
			expect(observed).toEqual(
				expect.arrayContaining([
					"group Office",
					"group Masthead",
					"region Quarterly",
					"region Visible",
					"table Quarterly totals",
					"caption Quarterly totals",
					"StaticText Daily",
					"sectionheader Scoped head",
					"sectionfooter Scoped foot",
				]),
			);
			// Date fields are text boxes to fill; slotted text names its link.
			expect(interactive).toEqual(expect.arrayContaining(["textbox When", "link Docs", "button Save"]));
			expect(docsLinks).toBe(1);
			expect(complementary).toBe(1);
			expect(await page.evaluate(unreselectable)).toEqual([]);
		} finally {
			await browser.close();
		}
	});
});
