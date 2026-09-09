import { describe, expect, it } from "bun:test";
import { handleCheatSh } from "@oh-my-pi/pi-coding-agent/web/scrapers/cheatsh";
import { handleRfc } from "@oh-my-pi/pi-coding-agent/web/scrapers/rfc";
import { handleTldr } from "@oh-my-pi/pi-coding-agent/web/scrapers/tldr";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleRfc", () => {
	it("returns null for non-RFC URLs", async () => {
		const result = await handleRfc("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for non-matching RFC domains", async () => {
		const result = await handleRfc("https://www.ietf.org/about/", 20);
		expect(result).toBeNull();
	});

	it("fetches RFC 2616 (HTTP/1.1)", async () => {
		const result = await handleRfc("https://www.rfc-editor.org/rfc/rfc2616", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("rfc");
		expect(result?.content).toContain("HTTP/1.1");
		expect(result?.content).toContain("Hypertext Transfer Protocol");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches RFC 2616 via datatracker URL", async () => {
		const result = await handleRfc("https://datatracker.ietf.org/doc/rfc2616/", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("rfc");
		expect(result?.content).toContain("HTTP/1.1");
	});

	it("fetches RFC 2616 via tools.ietf.org URL", async () => {
		const result = await handleRfc("https://tools.ietf.org/html/rfc2616", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("rfc");
		expect(result?.content).toContain("HTTP/1.1");
	});

	it("fetches RFC 793 (TCP)", async () => {
		const result = await handleRfc("https://www.rfc-editor.org/rfc/rfc793", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("rfc");
		expect(result?.content).toContain("Transmission Control Protocol");
	});
});

describe.skipIf(SKIP)("handleCheatSh", () => {
	it("returns null for non-cheat.sh URLs", async () => {
		const result = await handleCheatSh("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for empty topic", async () => {
		const result = await handleCheatSh("https://cheat.sh/", 20);
		expect(result).toBeNull();
	});

	it("fetches curl cheatsheet", async () => {
		const result = await handleCheatSh("https://cheat.sh/curl", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("cheat.sh");
		expect(result?.content).toContain("curl");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches tar cheatsheet", async () => {
		const result = await handleCheatSh("https://cheat.sh/tar", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("cheat.sh");
		expect(result?.content).toContain("tar");
	});

	it("fetches cheatsheet via cht.sh alias", async () => {
		const result = await handleCheatSh("https://cht.sh/curl", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("cheat.sh");
		expect(result?.content).toContain("curl");
	});
});

describe.skipIf(SKIP)("handleTldr", () => {
	it("returns null for non-tldr URLs", async () => {
		const result = await handleTldr("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for nested paths", async () => {
		const result = await handleTldr("https://tldr.sh/nested/path", 20);
		expect(result).toBeNull();
	});

	it("fetches git tldr page", async () => {
		const result = await handleTldr("https://tldr.sh/git", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("tldr");
		expect(result?.content).toContain("git");
		expect(result?.contentType).toBe("text/markdown");
	});

	it("fetches curl tldr page", async () => {
		const result = await handleTldr("https://tldr.sh/curl", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("tldr");
		expect(result?.content).toContain("curl");
	});

	it("fetches via tldr.ostera.io alias", async () => {
		const result = await handleTldr("https://tldr.ostera.io/git", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("tldr");
		expect(result?.content).toContain("git");
	});
});
