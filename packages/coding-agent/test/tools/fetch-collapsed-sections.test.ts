import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { mockFetch } from "../helpers/fetch-mock";

describe("read URL: collapsed sections", () => {
	it("keeps rows of a collapsed panel but not template or script text", async () => {
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

		const url = "https://example.com/product";
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated({ "providers.fetch": "local" }),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			fetch: mockFetch(input =>
				String(input) === url
					? new Response(html, { headers: { "content-type": "text/html" } })
					: new Response(null, { status: 404 }),
			),
		};
		const result = await fetchReadUrl(session, { path: url });

		expect(result.content).toMatch(/Brand[\s|]+Wakefit/);
		expect(result.content).toMatch(/Country of Origin[\s|]+India/);
		expect(result.content).not.toContain("Template-only claim");
		expect(result.content).not.toContain("Script-only claim");
	});
});
