import { describe, expect, it } from "bun:test";
import { browserDocumentation } from "@oh-my-pi/pi-coding-agent/tools/browser/prelude-definition";

const X11_NOTE = "On Linux under X11";

describe("browserDocumentation", () => {
	it("carries the Linux X11 click note only on Linux hosts", () => {
		const linux = browserDocumentation("linux");
		expect(linux).toContain(X11_NOTE);
		for (const platform of ["darwin", "win32"] as const) {
			const other = browserDocumentation(platform);
			expect(other).not.toContain(X11_NOTE);
			expect(other).not.toContain("{{");
			expect(other).toContain("Relay sessions are the user's real logged-in browser.");
		}
		expect(linux).not.toContain("{{");
	});
});
