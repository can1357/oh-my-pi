import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";

describe("renderHtmlToText: collapsed sections", () => {
	it("keeps rows of a collapsed panel but not template or script text", async () => {
		const settings = Settings.isolated({ "providers.fetch": "native" });
		const html = `<!doctype html><html><body><main>
<h1>Product information</h1>
<p>Details about this office chair, its materials, dimensions, and assembly requirements are in the panels below.</p>
<button aria-expanded="false">Item details</button>
<div style="display:none"><table>
<tr><td>Brand</td><td>Wakefit</td></tr>
<tr><td>Country of Origin</td><td>India</td></tr>
</table></div>
<template><p>Template-only claim</p></template>
<script>window.scriptOnlyClaim = "Script-only claim";</script>
</main></body></html>`;

		const result = await renderHtmlToText("https://example.com/product", html, 5, settings, undefined, null);

		expect(result.ok).toBe(true);
		expect(result.method).toBe("native");
		expect(result.content).toMatch(/\| Brand\s+\| Wakefit\s+\|/);
		expect(result.content).toMatch(/\| Country of Origin\s+\| India\s+\|/);
		expect(result.content).not.toContain("Template-only claim");
		expect(result.content).not.toContain("Script-only claim");
	});
});
