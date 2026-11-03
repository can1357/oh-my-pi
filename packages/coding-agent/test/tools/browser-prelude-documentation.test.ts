import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { browserDocumentation } from "@oh-my-pi/pi-coding-agent/tools/browser/prelude-definition";

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
		expect(local).toContain("Relay sessions are the user's real logged-in browser.");
	});
});
