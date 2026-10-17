import { describe, expect, it } from "bun:test";

import { formatProviderName } from "@oh-my-pi/pi-tui/chrome/format";

describe("formatProviderName", () => {
	it("uses a provider's brand spelling when the id-derived name would be wrong", () => {
		expect(formatProviderName("commandcode")).toBe("Command Code");
		// Provider ids reach the formatter from reports and CLI flags alike, so
		// the lookup must not depend on the caller's casing.
		expect(formatProviderName("CommandCode")).toBe("Command Code");
	});

	it("title-cases ids the brand table does not cover", () => {
		expect(formatProviderName("openai-codex")).toBe("Openai Codex");
		expect(formatProviderName("google-antigravity")).toBe("Google Antigravity");
		expect(formatProviderName("zai")).toBe("Zai");
		expect(formatProviderName("anthropic_custom")).toBe("Anthropic Custom");
	});
});
