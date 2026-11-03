import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { registerSemanticQueryHandlers } from "@oh-my-pi/pi-coding-agent/tools/browser/query-handlers";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TERN_KIT_SOURCE } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/page-kit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import puppeteer from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const available = await chromiumAvailable();
afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

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
				<section id="section" aria-labelledby="heading"><h2 id="heading">billing-worker</h2></section>
				<section id="unnamed-section">Content alone is not a name</section>
				<section id="title-section" title="Title section"></section>
				<section id="empty-section" aria-labelledby="missing" aria-label=" ">Content</section>
				<form id="form" aria-label="Named form"></form><form id="unnamed-form">Content</form>
				<header id="header" aria-label="Header"></header><footer id="footer" aria-label="Footer"></footer>
				${["article", "aside", "main", "nav", "section"].map(tag => `<${tag}><header id="${tag}-header" aria-label="${tag} header"></header><footer id="${tag}-footer" aria-label="${tag} footer"></footer></${tag}>`).join("")}
				<fieldset id="legend-fieldset"><legend>Legend name</legend></fieldset>
				<figure id="caption-figure"><figcaption>Caption name</figcaption></figure>
				<select><optgroup id="optgroup" label="Options"><option>One</option></optgroup></select>
				<table><thead id="thead" aria-label="Head"><tr><th>H</th></tr></thead><tbody id="tbody" aria-label="Body"><tr><td>B</td></tr></tbody><tfoot id="tfoot" aria-label="Foot"><tr><td>F</td></tr></tfoot></table>
				<dl><dt id="dt">Term</dt><dd id="dd" aria-label="Definition">Definition</dd></dl>
				<datalist id="datalist" style="display:block" aria-label="Suggestions"><option>One</option></datalist>
				<img id="decorative" alt="" src="data:,"><img id="named-image" alt="" aria-label="Named image" src="data:,">
				<map name="links"><area id="area" href="#target" alt="Mapped link" shape="rect" coords="0,0,20,20"></map>
				<img usemap="#links" width="30" height="30" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">`);
			await page.evaluate(`(function () {\n${TERN_KIT_SOURCE}\n})()`);
			const cdp = await page.createCDPSession();
			const { root } = await cdp.send("DOM.getDocument");
			const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[id]" });
			const mismatches = [];
			for (const nodeId of nodeIds) {
				const { node } = await cdp.send("DOM.describeNode", { nodeId });
				const attributes = node.attributes ?? [];
				const id = attributes[attributes.indexOf("id") + 1];
				const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
				const ax = nodes[0];
				const role = String(ax.role?.value).toLowerCase();
				const name = String(ax.name?.value ?? "");
				const query = name ? `${role}[name="${name}" exact]` : role;
				const ids = await page.$$eval(`role/${query}`, elements => elements.map(element => element.id));
				const ternCount = await page.evaluate(query => {
					// The kit is installed above in this page's realm.
					const globals = globalThis as unknown as { __ompTernKit: { count(selector: unknown): number } };
					return globals.__ompTernKit.count({ engine: "role", query });
				}, query);
				if (!ids.includes(id) || ternCount !== ids.length) mismatches.push({ id, role, name, ids, ternCount });
			}
			expect(mismatches).toEqual([]);
			expect(await page.$$eval("role/region", elements => elements.map(element => element.id))).toEqual([
				"section",
				"title-section",
			]);
		} finally {
			await browser.close();
		}
	});

	it("scopes ariaSnapshot and observe to one named section with repeated control labels", async () => {
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
		const context = { session, toolCallId: "implicit-roles" };
		const html = `<!doctype html>${["billing-worker", "search-worker", "mail-worker"].map(name => `<section class="svc" aria-labelledby="svc-${name}"><h2 id="svc-${name}">${name}</h2><label>REGION<select><option>${name}-region</option></select></label></section>`).join("")}`;
		await prelude.invoke(
			{ action: "open", name: "implicit-roles", url: `data:text/html,${encodeURIComponent(html)}` },
			context,
		);
		const result = (await prelude.invoke(
			{
				action: "run",
				name: "implicit-roles",
				code: `const selector = 'role/region[name="billing-worker"]'; return { snapshot: await tab.ariaSnapshot(selector), exactSnapshot: await tab.ariaSnapshot('role/region[name="billing-worker" exact]'), observation: await tab.observe({selector}) };`,
			},
			context,
		)) as {
			details?: {
				value?: {
					snapshot: string;
					exactSnapshot: string;
					observation: { elements: { role: string; name: string; value?: string }[] };
				};
			};
		};
		const value = result.details?.value;
		expect(value?.snapshot).toContain('region "billing-worker"');
		expect(value?.exactSnapshot).toBe(value?.snapshot);
		expect(value?.snapshot).not.toContain("search-worker");
		expect(value?.observation.elements.filter(element => element.role === "combobox")).toMatchObject([
			{ name: "REGION", value: "billing-worker-region" },
		]);
		console.log(
			JSON.stringify({
				snapshot: value?.snapshot,
				controls: value?.observation.elements.filter(element => element.role === "combobox"),
			}),
		);
	});
});
