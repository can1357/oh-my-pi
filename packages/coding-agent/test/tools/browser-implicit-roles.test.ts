import { describe, expect, it } from "bun:test";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { registerSemanticQueryHandlers } from "@oh-my-pi/pi-coding-agent/tools/browser/query-handlers";
import { TERN_KIT_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-kit";
import puppeteer from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const available = await chromiumAvailable();

describe.skipIf(!available)("browser implicit role selectors", () => {
	it("matches Chrome's computed roles and names through Puppeteer and the serialized Tern kit", async () => {
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			const tags = [
				"aside",
				"dialog",
				"fieldset",
				"details",
				"hr",
				"progress",
				"meter",
				"output",
				"search",
				"menu",
				"address",
				"hgroup",
				"dl",
				"figure",
				"blockquote",
				"p",
				"code",
				"em",
				"strong",
				"del",
				"s",
				"ins",
				"sub",
				"sup",
				"time",
				"mark",
				"dfn",
			];
			await page.setContent(`<!doctype html>
				${tags.map(tag => `<${tag} id="${tag}" aria-label="${tag}" open>Content</${tag}>`).join("")}
				${["billing-worker", "search-worker", "mail-worker"].map(name => `<section id="${name}" aria-labelledby="heading-${name}"><h2 id="heading-${name}">${name}</h2><label>REGION<select><option>${name}-region</option></select></label></section>`).join("")}
				<section id="unnamed-section">Content alone is not a name</section>
				<section id="title-section" title="Title section"></section>
				<section id="empty-section" aria-labelledby="missing" aria-label=" ">Content</section>
				<section id="primary-section" aria-label="Fallback" aria-labelledby="primary-heading"></section><h2 id="primary-heading">Primary</h2>
				<section id="aria-name-section" aria-labelledby="aria-name-heading"></section><h2 id="aria-name-heading" aria-label="Billing"></h2>
				<article><aside id="aria-name-aside" aria-labelledby="aria-name-heading"></aside></article>
				<section id="alt-name-section" aria-labelledby="alt-name-image"></section><img id="alt-name-image" alt="Logo" src="data:,">
				<section id="input-button-section" aria-labelledby="input-button-label"></section><input id="input-button-label" type="button" value="Billing input">
				<section id="submit-target-section" aria-labelledby="submit-target"></section><input id="submit-target" type="submit">
				<section id="reset-target-section" aria-labelledby="reset-target"></section><input id="reset-target" type="reset">
				<section id="image-input-section" aria-labelledby="image-input-label"></section><input id="image-input-label" type="image" alt="Image input" src="data:,">
				<section id="title-target-section" aria-labelledby="title-target"></section><span id="title-target" role="note" title="Titled target"></span>
				<section id="text-input-section" aria-labelledby="text-input-label"></section><input id="text-input-label" value="Typed name">
				<section id="area-name-section" aria-labelledby="area"></section>
				<label>Field <dfn id="label-dfn">required</dfn><input></label>
				<section id="bare-image-section" aria-labelledby="bare-image-target"></section><input id="bare-image-target" type="image" src="data:,">
				<div style="display:none"><span id="hidden-ancestor-target"><b style="display:none">Hidden</b> name</span></div><section id="hidden-ancestor-section" aria-labelledby="hidden-ancestor-target"></section>
				<span id="contents-target" role="note" style="display:contents">Visible <b hidden>Hidden</b></span><section id="contents-section" aria-labelledby="contents-target"></section>
				<form id="form" aria-label="Named form"></form><form id="unnamed-form">Content</form>
				<header id="header" aria-label="Header"></header><footer id="footer" aria-label="Footer"></footer>
				${["article", "aside", "main", "nav", "section"].map(tag => `<${tag}><header id="${tag}-header" aria-label="${tag} header"></header><footer id="${tag}-footer" aria-label="${tag} footer"></footer></${tag}>`).join("")}
				${["main", "navigation", "article", "complementary", "region"].map(role => `<div role="${role}" aria-label="Container"><header id="role-${role}-header" aria-label="${role} header"></header><footer id="role-${role}-footer" aria-label="${role} footer"></footer><aside id="role-${role}-aside">Nested aside</aside></div>`).join("")}
				<section role="none"><header id="none-header" aria-label="None header"></header><footer id="none-footer" aria-label="None footer"></footer></section>
				${["article", "aside", "main", "nav", "section"].map(tag => `<${tag}><aside id="${tag}-aside">Nested aside</aside><aside id="${tag}-named-aside" aria-label="${tag} sidebar"></aside></${tag}>`).join("")}
				<fieldset id="legend-fieldset"><legend>Legend name</legend></fieldset>
				<fieldset id="unnamed-fieldset">Unrelated text</fieldset>
				<figure id="caption-figure"><img alt="Photo" src="data:,"><figcaption>Caption name</figcaption></figure>
				<select><optgroup id="optgroup" label="Options"><option>One</option></optgroup></select>
				<label>Category<select><optgroup id="wrapped-optgroup" label="Fruit"><option>Apple</option></optgroup></select></label>
				<select><optgroup id="title-optgroup" title="Titled group"><option>Pear</option></optgroup></select>
				<table><thead id="thead" aria-label="Head"><tr><th>H</th></tr></thead><tbody id="tbody" aria-label="Body"><tr><td>B</td></tr></tbody><tfoot id="tfoot" aria-label="Foot"><tr><td>F</td></tr></tfoot></table>
				<table id="caption-table"><caption>Quarterly results</caption><tr><td>Profit</td></tr></table>
				<section id="table-target-section" aria-labelledby="caption-table"></section>
				<table id="aria-caption-table"><caption aria-label="Labelled caption">Visible caption</caption><tr><td>Cell</td></tr></table>
				<dl><dt id="dt">Term</dt><dd id="dd" aria-label="Definition">Definition</dd></dl>
				<img id="decorative" alt="" src="data:,"><img id="named-image" alt="" aria-label="Named image" src="data:,">
				<img id="described-image" alt="" aria-describedby="description" src="data:,"><p id="description" aria-label="Description">Description</p>
				<img id="missing-label-image" alt="" aria-labelledby="missing" src="data:,">
				<map name="links"><area id="area" href="#target" alt="Mapped link" shape="rect" coords="0,0,20,20"></map>
				<img usemap="#links" width="30" height="30" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">`);
			await page.evaluate(`(function () {\n${TERN_KIT_SOURCE}\n})()`);
			const cdp = await page.createCDPSession();
			const { root } = await cdp.send("DOM.getDocument");
			const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[id]" });
			const computed: { id: string; role: string; name: string }[] = [];
			for (const nodeId of nodeIds) {
				const { node } = await cdp.send("DOM.describeNode", { nodeId });
				const attributes = node.attributes ?? [];
				const id = attributes[attributes.indexOf("id") + 1];
				const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
				const ax = nodes[0];
				// An ignored node (not rendered, or presentational like a decorative image) is outside the accessibility
				// tree, so no Chromium role/ selector matches it; it only matters as a label source.
				if (ax.ignored) continue;
				const role = String(ax.role?.value).toLowerCase();
				const name = String(ax.name?.value ?? "");
				computed.push({ id, role, name });
			}
			const mismatches = [];
			for (const { role, name } of computed) {
				const query = `${role}[name="${name}" exact]`;
				const expected = computed
					.filter(entry => entry.role === role && entry.name === name)
					.map(entry => entry.id)
					.sort();
				const ids = await page.$$eval(`role/${query}`, elements => elements.map(element => element.id));
				const ternCount = await page.evaluate(query => {
					// The kit is installed above in this page's realm.
					const globals = globalThis as unknown as { __ompTernKit: { count(selector: unknown): number } };
					return globals.__ompTernKit.count({ engine: "role", query });
				}, query);
				// Chrome leaves plain containers (divs, spans) out of its tree while the kit calls them all generic, so
				// generic counts are compared through the ids above only.
				const ternMatches = role === "generic" || ternCount === ids.length;
				if (JSON.stringify(ids.filter(Boolean).sort()) !== JSON.stringify(expected) || !ternMatches) {
					mismatches.push({ query, expected, ids, ternCount });
				}
			}
			expect(mismatches).toEqual([]);
			expect(
				await page.$$eval('role/region[name="billing-worker"]', elements => elements.map(element => element.id)),
			).toEqual(["billing-worker"]);
		} finally {
			await browser.close();
		}
	}, 120_000);

	it("bounds cyclic native-label references in named role queries", async () => {
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent(`
				<table id="table"><caption aria-labelledby="table">Results</caption><tr><td>Value</td></tr></table>
				<fieldset id="fieldset"><legend aria-labelledby="fieldset">Settings</legend></fieldset>`);
			await page.evaluate(`(function () {\n${TERN_KIT_SOURCE}\n})()`);
			// Chrome names the table "Results Value" (its caption names it after the table's own text); the Tern kit, which
			// must not recurse forever on the cycle, names it "Results". Both contain the filter.
			for (const query of ['table[name="Results"]', 'group[name="Settings" exact]']) {
				expect(await page.$$eval(`role/${query}`, elements => elements.length)).toBe(1);
				expect(
					await page.evaluate(query => {
						const globals = globalThis as unknown as { __ompTernKit: { count(selector: unknown): number } };
						return globals.__ompTernKit.count({ engine: "role", query });
					}, query),
				).toBe(1);
			}
		} finally {
			await browser.close();
		}
	});

	it("refuses a role selector with text after its name filter instead of matching the outer role", async () => {
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent(
				`<section id="billing" aria-labelledby="h"><h2 id="h">billing-worker</h2><label>REGION<select><option>x</option></select></label></section>`,
			);
			await page.evaluate(`(function () {\n${TERN_KIT_SOURCE}\n})()`);
			for (const query of [
				'region[name="billing-worker" exact] >> role/combobox[name="REGION" exact]',
				'region[name="billing-worker"][level=2]',
				"region>>role/combobox",
				"button.foo",
			]) {
				const puppeteerError = await page.$$eval(`role/${query}`, elements => elements.length).catch(String);
				expect(String(puppeteerError)).toContain("role/ selectors do not chain");
				const ternError = await page
					.evaluate(query => {
						const globals = globalThis as unknown as { __ompTernKit: { count(selector: unknown): number } };
						return globals.__ompTernKit.count({ engine: "role", query });
					}, query)
					.catch(String);
				expect(String(ternError)).toContain("role/ selectors do not chain");
			}
			expect(await page.$$eval('role/region [name="billing-worker" exact] ', elements => elements.length)).toBe(1);
		} finally {
			await browser.close();
		}
	}, 60_000);

	it("resolves roles under deeply nested asides without recomputing every ancestor", async () => {
		registerSemanticQueryHandlers(puppeteer);
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			// Each unnamed aside's role depends on its ancestors' roles; recomputed per level, 40 levels never finish.
			await page.setContent(`${"<aside>".repeat(40)}<header aria-label="Deep">x</header>${"</aside>".repeat(40)}`);
			expect(await page.$$eval("role/complementary", elements => elements.length)).toBe(1);
			expect(
				await page.$$eval("role/generic", elements => elements.filter(e => e.localName === "aside").length),
			).toBe(39);
		} finally {
			await browser.close();
		}
	}, 60_000);

	it("reports the role and name a role/ selector takes back from the Tern kit's observe()", async () => {
		const browser = await puppeteer.launch({ executablePath: await ensureChromiumExecutable(), headless: true });
		try {
			const page = await browser.newPage();
			await page.setContent(`<!doctype html>
				<section title="Title section"><button>A</button></section>
				<section aria-label="Fallback" aria-labelledby="primary"><h2 id="primary">Primary</h2><button>B</button></section>
				<section aria-labelledby="svc"><span id="svc" aria-label="Billing"></span><button>C</button></section>
				<select><optgroup label="Fruit"><option>Apple</option></optgroup></select>
				<section aria-labelledby="titled-img"><img id="titled-img" alt="" title="Pictured" src="data:,"><button>D</button></section>
				<section aria-labelledby="choice"><select id="choice"><option selected>One</option><option>Two</option></select></section>
				<figure><img alt="Photo" src="data:,"><figcaption>Caption</figcaption></figure>`);
			await page.evaluate(`(function () {\n${TERN_KIT_SOURCE}\n})()`);
			const observed = await page.evaluate(() => {
				const kit = (
					globalThis as unknown as {
						__ompTernKit: {
							observe(opts: unknown): { elements: { role: string; name: string }[] };
							count(selector: unknown): number;
						};
					}
				).__ompTernKit;
				return kit
					.observe({ includeAll: true })
					.elements.filter(entry => ["region", "group", "figure"].includes(entry.role) && entry.name)
					.map(entry => {
						const query = `${entry.role}[name="${entry.name}" exact]`;
						return [query, kit.count({ engine: "role", query })];
					});
			});
			// Every named region, group and figure the observer reports reselects exactly that element.
			expect(observed.filter(([, matched]) => matched !== 1)).toEqual([]);
			expect(observed).toEqual(
				expect.arrayContaining([
					['region[name="Title section" exact]', 1],
					['region[name="Primary" exact]', 1],
					['region[name="Billing" exact]', 1],
					['group[name="Fruit" exact]', 1],
					['region[name="Pictured" exact]', 1],
					['region[name="One" exact]', 1],
				]),
			);
		} finally {
			await browser.close();
		}
	}, 60_000);
});
