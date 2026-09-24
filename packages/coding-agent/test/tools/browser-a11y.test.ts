import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { BrowserA11yResult } from "@oh-my-pi/pi-coding-agent/tools/browser/a11y/audit";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function createHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: `browser-a11y-${crypto.randomUUID()}` });
}

function valueFrom<T>(result: { details?: unknown }): T {
	if (!result.details || typeof result.details !== "object" || !("value" in result.details)) {
		throw new Error("Browser result did not include a value");
	}
	return result.details.value as T;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser accessibility audit", () => {
	test("audits contrast, scopes rules and selectors, preserves iframe paths, and leaves page axe untouched", async () => {
		const invoke = createHost();
		const html = `<!doctype html>
<html lang="en"><head><title>A11y fixture</title></head><body>
<script>window.axe = 1;</script>
<img id="missing-alt" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<div id="low-contrast" style="color:#aaa;background-color:#fff;font-size:20px">Unreadable</div>
<section id="scope"><img id="inside-scope" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></section>
<img id="outside-scope" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<iframe id="child-frame" srcdoc="<html lang='en'><head><title>Child</title></head><body><img id='frame-image' src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='></body></html>"></iframe>
</body></html>`;
		await invoke({
			action: "open",
			name: "a11y",
			url: `data:text/html,${encodeURIComponent(html)}`,
		});

		const fullResult = await invoke({
			action: "call",
			name: "a11y",
			chain: [{ method: "a11y", args: [] }],
		});
		const full = valueFrom<BrowserA11yResult>(fullResult);
		const imageAlt = full.violations.find(result => result.id === "image-alt");
		const contrast = full.violations.find(result => result.id === "color-contrast");
		expect(imageAlt).toBeDefined();
		expect(contrast).toBeDefined();
		expect(imageAlt?.nodes.some(node => JSON.stringify(node.target).includes("#missing-alt"))).toBe(true);
		expect(contrast?.nodes.some(node => JSON.stringify(node.target).includes("#low-contrast"))).toBe(true);
		expect(
			imageAlt?.nodes.some(
				node =>
					Array.isArray(node.target) &&
					node.target.length === 2 &&
					JSON.stringify(node.target).includes("#child-frame") &&
					JSON.stringify(node.target).includes("#frame-image"),
			),
		).toBe(true);
		expect(
			fullResult.content.some(
				block =>
					block.type === "text" &&
					block.text.includes("[critical] image-alt:") &&
					block.text.includes("https://dequeuniversity.com/rules/axe/"),
			),
		).toBe(true);

		const tagged = valueFrom<BrowserA11yResult>(
			await invoke({
				action: "call",
				name: "a11y",
				chain: [{ method: "a11y", args: [{ tags: ["wcag2a"] }] }],
			}),
		);
		expect(tagged.violations.some(result => result.id === "image-alt")).toBe(true);
		expect(tagged.violations.some(result => result.id === "color-contrast")).toBe(false);

		const scoped = valueFrom<BrowserA11yResult>(
			await invoke({
				action: "call",
				name: "a11y",
				chain: [{ method: "a11y", args: [{ rules: ["image-alt"], selector: "#scope" }] }],
			}),
		);
		const scopedImages = scoped.violations.find(result => result.id === "image-alt");
		expect(scopedImages?.nodeCount).toBe(1);
		expect(JSON.stringify(scopedImages?.nodes[0]?.target)).toContain("#inside-scope");
		expect(JSON.stringify(scopedImages?.nodes)).not.toContain("#outside-scope");

		const pageAxe = await invoke({
			action: "run",
			name: "a11y",
			code: "return await tab.evaluate(() => window.axe)",
		});
		expect(valueFrom<number>(pageAxe)).toBe(1);
	}, 30_000);
});
