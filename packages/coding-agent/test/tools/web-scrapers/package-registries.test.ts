import { describe, expect, it } from "bun:test";
import { handleCratesIo } from "@oh-my-pi/pi-coding-agent/web/scrapers/crates-io";
import { handleGoPkg } from "@oh-my-pi/pi-coding-agent/web/scrapers/go-pkg";
import { handleHex } from "@oh-my-pi/pi-coding-agent/web/scrapers/hex";
import { handleNpm } from "@oh-my-pi/pi-coding-agent/web/scrapers/npm";
import { handlePubDev } from "@oh-my-pi/pi-coding-agent/web/scrapers/pub-dev";
import { handlePyPI } from "@oh-my-pi/pi-coding-agent/web/scrapers/pypi";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

describe.skipIf(SKIP)("handlePyPI", () => {
	it("returns null for non-PyPI URLs", async () => {
		const result = await handlePyPI("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid PyPI URLs", async () => {
		const result = await handlePyPI("https://pypi.org/invalid", 10);
		expect(result).toBeNull();
	});

	it("returns null for PyPI URLs without project path", async () => {
		const result = await handlePyPI("https://pypi.org/", 10);
		expect(result).toBeNull();
	});

	it("fetches requests package", async () => {
		const result = await handlePyPI("https://pypi.org/project/requests/", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("pypi");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("requests");
		expect(result?.content).toMatch(/Latest.*\d+\.\d+/);
		expect(result?.notes).toContain("Fetched via PyPI JSON API");
	});

	it("extracts package name correctly", async () => {
		const result = await handlePyPI("https://pypi.org/project/requests/2.28.0/", 20);
		expect(result).not.toBeNull();
		expect(result?.content).toContain("requests");
	});

	it("handles www subdomain", async () => {
		const result = await handlePyPI("https://www.pypi.org/project/requests/", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("pypi");
	});
});

describe.skipIf(SKIP)("handleGoPkg", () => {
	it("returns null for non-pkg.go.dev URLs", async () => {
		const result = await handleGoPkg("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for pkg.go.dev root without package", async () => {
		const result = await handleGoPkg("https://pkg.go.dev/", 10);
		expect(result).toBeNull();
	});

	it("fetches gin package", async () => {
		const result = await handleGoPkg("https://pkg.go.dev/github.com/gin-gonic/gin", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("go-pkg");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toMatch(/Module:/);
		expect(result?.content).toMatch(/Version:/);
		expect(result?.content).toMatch(/License:/);
	});

	it("handles package with version", async () => {
		const result = await handleGoPkg("https://pkg.go.dev/github.com/gin-gonic/gin@v1.9.0", 20);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Version:\*\*\s*v1\.9\.0/);
	});

	it("extracts package documentation", async () => {
		const result = await handleGoPkg("https://pkg.go.dev/github.com/gin-gonic/gin", 20);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Documentation|Synopsis|Index/);
	});
});

describe.skipIf(SKIP)("handleHex", () => {
	it("returns null for non-hex.pm URLs", async () => {
		const result = await handleHex("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid hex.pm URLs", async () => {
		const result = await handleHex("https://hex.pm/invalid", 10);
		expect(result).toBeNull();
	});

	it("returns null for hex.pm URLs without package path", async () => {
		const result = await handleHex("https://hex.pm/", 10);
		expect(result).toBeNull();
	});

	it("fetches phoenix package", async () => {
		const result = await handleHex("https://hex.pm/packages/phoenix", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("hex");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("phoenix");
		expect(result?.content).toMatch(/Latest.*\d+\.\d+/);
		expect(result?.notes).toContain("Fetched via Hex.pm API");
	});

	it("extracts package description", async () => {
		const result = await handleHex("https://hex.pm/packages/phoenix", 20);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/phoenix|Phoenix|web framework/i);
	});

	it("handles www subdomain", async () => {
		const result = await handleHex("https://www.hex.pm/packages/phoenix", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("hex");
	});

	it("includes download statistics", async () => {
		const result = await handleHex("https://hex.pm/packages/phoenix", 20);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Total Downloads|This Week/);
	});
});

describe.skipIf(SKIP)("handlePubDev", () => {
	it("returns null for non-pub.dev URLs", async () => {
		const result = await handlePubDev("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid pub.dev URLs", async () => {
		const result = await handlePubDev("https://pub.dev/invalid", 10);
		expect(result).toBeNull();
	});

	it("returns null for pub.dev URLs without package path", async () => {
		const result = await handlePubDev("https://pub.dev/", 10);
		expect(result).toBeNull();
	});

	it("fetches flutter package", async () => {
		const result = await handlePubDev("https://pub.dev/packages/flutter", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("pub.dev");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("flutter");
		expect(result?.content).toMatch(/Latest.*\d+\.\d+/);
		expect(result?.notes).toContain("Fetched via pub.dev API");
	});

	it("extracts package metadata", async () => {
		const result = await handlePubDev("https://pub.dev/packages/http", 20);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/SDK:/);
	});

	it("handles www subdomain", async () => {
		const result = await handlePubDev("https://www.pub.dev/packages/flutter", 20);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("pub.dev");
	});

	it("includes package dependencies", async () => {
		const result = await handlePubDev("https://pub.dev/packages/http", 20);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Dependencies/);
	});
});

describe.skipIf(SKIP)("handleNpm", () => {
	it("returns null for non-npm URLs", async () => {
		const result = await handleNpm("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid npm URLs", async () => {
		const result = await handleNpm("https://www.npmjs.com/invalid", 10);
		expect(result).toBeNull();
	});

	it("fetches lodash package", async () => {
		const result = await handleNpm("https://www.npmjs.com/package/lodash", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("npm");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("lodash");
		expect(result?.content).toMatch(/Latest.*\d+\.\d+/);
		expect(result?.notes).toContain("Fetched via npm registry");
	});

	it("includes version info", async () => {
		const result = await handleNpm("https://www.npmjs.com/package/express", 20000);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Latest:\*\*\s*\d+\.\d+\.\d+/);
	});

	it("includes download stats", async () => {
		const result = await handleNpm("https://www.npmjs.com/package/express", 20000);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Weekly Downloads/);
	});

	it("handles www subdomain", async () => {
		const result = await handleNpm("https://www.npmjs.com/package/lodash", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("npm");
	});

	it("handles npmjs.com without www", async () => {
		const result = await handleNpm("https://npmjs.com/package/lodash", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("npm");
	});
});

describe.skipIf(SKIP)("handleCratesIo", () => {
	it("returns null for non-crates.io URLs", async () => {
		const result = await handleCratesIo("https://example.com", 10);
		expect(result).toBeNull();
	});

	it("returns null for invalid crates.io URLs", async () => {
		const result = await handleCratesIo("https://crates.io/invalid", 10);
		expect(result).toBeNull();
	});

	it("fetches serde package", async () => {
		const result = await handleCratesIo("https://crates.io/crates/serde", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("crates.io");
		expect(result?.contentType).toBe("text/markdown");
		expect(result?.content).toContain("serde");
		expect(result?.content).toMatch(/Latest.*\d+\.\d+/);
		expect(result?.notes).toContain("Fetched via crates.io API");
	});

	it("includes version info", async () => {
		const result = await handleCratesIo("https://crates.io/crates/tokio", 20000);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Latest:\*\*\s*\d+\.\d+\.\d+/);
	});

	it("includes download stats", async () => {
		const result = await handleCratesIo("https://crates.io/crates/tokio", 20000);
		expect(result).not.toBeNull();
		expect(result?.content).toMatch(/Downloads:\*\*/);
		expect(result?.content).toMatch(/total.*recent/);
	});

	it("handles www subdomain", async () => {
		const result = await handleCratesIo("https://www.crates.io/crates/serde", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("crates.io");
	});
});
