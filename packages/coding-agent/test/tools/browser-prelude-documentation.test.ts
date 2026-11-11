import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import {
	browserDocumentation,
	createBrowserPreludeDefinition,
} from "@oh-my-pi/pi-coding-agent/tools/browser/prelude-definition";
import { cfgBrowserCdpUrl } from "@oh-my-pi/pi-coding-agent/tools/browser/settings";

const X11_NOTE = "On Linux under X11";

describe("browserDocumentation", () => {
	it("carries the Linux X11 click note on Linux hosts and for a configured browser on another machine", () => {
		expect(browserDocumentation(Settings.isolated(), "linux")).toContain(X11_NOTE);
		expect(browserDocumentation(Settings.isolated({ "browser.cdpUrl": "http://10.0.0.5:9222" }), "darwin")).toContain(
			X11_NOTE,
		);
		const local = browserDocumentation(Settings.isolated({ "browser.cdpUrl": "http://127.0.0.1:9222" }), "darwin");
		expect(local).not.toContain(X11_NOTE);
		expect(local).not.toContain("{{");
	});

	// Off Linux the note depends on the settings alone, so a settings change shows in the next read.
	it.skipIf(process.platform === "linux")("follows a browser.cdpUrl change after the prelude was built", () => {
		const settings = Settings.isolated();
		const definition = createBrowserPreludeDefinition({ settings } as ToolSession, {
			invoke: async () => ({ content: [] }),
		});
		expect(definition.documentation).not.toContain(X11_NOTE);
		expect(definition.guidance ?? "").not.toContain(X11_NOTE);
		expect(definition.guidance).toContain("# Browser user sessions");
		cfgBrowserCdpUrl.set(settings, "http://10.0.0.5:9222");
		expect(definition.documentation).toContain(X11_NOTE);
		expect(definition.guidance).toContain(X11_NOTE);
		expect(definition.guidance).toContain("# Browser user sessions");
	});
});

/** Identifiers inside the inline code spans of a Markdown document (`tab.click(selector)` → tab, click, selector). */
function codeIdentifiers(markdown: string): Set<string> {
	const names = new Set<string>();
	for (const [, span] of markdown.matchAll(/`([^`\n]+)`/g)) {
		if (span.startsWith("xd://")) continue;
		for (const [name] of span.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(name);
	}
	return names;
}

describe("browser core documentation", () => {
	// The core arrives in a hidden session message; the full doc stays the `xd://eval/browser` topic. Every helper,
	// option and parameter the core names must also be in the full doc, so a rename there cannot leave the core stale.
	it("names only helpers, options and parameters the full browser doc names", () => {
		const definition = createBrowserPreludeDefinition({ settings: Settings.isolated() } as ToolSession, {
			invoke: async () => ({ content: [] }),
		});
		const full = codeIdentifiers(browserDocumentation(Settings.isolated(), "darwin"));
		const core = codeIdentifiers(definition.firstCallDocumentation ?? "");
		expect(core.size).toBeGreaterThan(0);
		expect([...core].filter(name => !full.has(name))).toEqual([]);
	});
});
