import { describe, expect, it } from "bun:test";
import { handleStackOverflow } from "@oh-my-pi/pi-coding-agent/web/scrapers/stackoverflow";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handleStackOverflow", () => {
	it("returns null for non-SE URLs", async () => {
		const result = await handleStackOverflow("https://example.com", 20);
		expect(result).toBeNull();
	});

	it("returns null for SE site without question path", async () => {
		const result = await handleStackOverflow("https://stackoverflow.com/tags", 20);
		expect(result).toBeNull();
	});

	it("returns null for SE user profile URLs", async () => {
		const result = await handleStackOverflow("https://stackoverflow.com/users/1", 20);
		expect(result).toBeNull();
	});

	// stackoverflow.com - "What is a NullPointerException" (classic, highly voted)
	it("fetches stackoverflow.com question", async () => {
		const result = await handleStackOverflow(
			"https://stackoverflow.com/questions/218384/what-is-a-nullpointerexception-and-how-do-i-fix-it",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("stackexchange");
		expect(result?.content).toContain("NullPointerException");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.notes?.[0]).toContain("site=stackoverflow");
	});

	// unix.stackexchange.com - "Why does my shell script choke on whitespace" (classic)
	it("fetches unix.stackexchange.com question", async () => {
		const result = await handleStackOverflow(
			"https://unix.stackexchange.com/questions/131766/why-does-my-shell-script-choke-on-whitespace-or-other-special-characters",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("stackexchange");
		expect(result?.content).toContain("whitespace");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.notes?.[0]).toContain("site=unix");
	});

	// superuser.com - "What are PATH and other environment variables" (stable)
	it("fetches superuser.com question", async () => {
		const result = await handleStackOverflow(
			"https://superuser.com/questions/284342/what-are-path-and-other-environment-variables-and-how-can-i-set-or-use-them",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("stackexchange");
		expect(result?.content).toContain("PATH");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.notes?.[0]).toContain("site=superuser");
	});

	// askubuntu.com - "What is the difference between apt and apt-get" (iconic)
	it("fetches askubuntu.com question", async () => {
		const result = await handleStackOverflow(
			"https://askubuntu.com/questions/445384/what-is-the-difference-between-apt-and-apt-get",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("stackexchange");
		expect(result?.content).toContain("apt");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.notes?.[0]).toContain("site=askubuntu");
	});

	// serverfault.com - "What is a reverse proxy" (stable sysadmin topic)
	it("fetches serverfault.com question", async () => {
		const result = await handleStackOverflow(
			"https://serverfault.com/questions/127021/what-is-the-difference-between-a-proxy-and-a-reverse-proxy",
			20,
		);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("stackexchange");
		expect(result?.content).toMatch(/proxy/i);
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.notes?.[0]).toContain("site=serverfault");
	});

	// Test with www. prefix

	// Verify response structure
	it("returns complete response structure", async () => {
		const result = await handleStackOverflow("https://stackoverflow.com/questions/218384", 20);
		expect(result).not.toBeNull();
		expect(result).toHaveProperty("contentType", "text/markdown");
		expect(result).toHaveProperty("method", "stackexchange");
		// Content should have question structure
		expect(result?.content).toContain("# ");
		expect(result?.content).toContain("Score:");
		expect(result?.content).toContain("Tags:");
	});
});
