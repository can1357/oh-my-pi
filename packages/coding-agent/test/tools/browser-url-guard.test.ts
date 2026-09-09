/**
 * SSRF / private-IP navigation guard: ported from hermes-agent
 * (`tools/url_safety.py`, `tools/browser_tool.py::_url_is_private`), MIT,
 * Copyright (c) 2025 Nous Research. See src/tools/browser/NOTICE.
 *
 * Every case injects a fake resolver through the policy `lookup` seam, so the
 * suite never touches real DNS.
 */
import { describe, expect, it } from "bun:test";
import {
	checkNavigationTarget,
	classifyIpAddress,
	isAlwaysBlockedNavigationTarget,
	isBlockedCommittedNavigation,
	navigationBlockedMessage,
	resolveNavigationPolicy,
} from "../../src/tools/browser/url-guard";

/** Resolver mapping hostnames to fixed addresses; anything else throws. */
function fakeDns(table: Record<string, string | string[]>): (hostname: string) => Promise<string[]> {
	return async (hostname: string): Promise<string[]> => {
		const hit = table[hostname];
		if (hit === undefined) throw new Error(`no fake record for ${hostname}`);
		return Array.isArray(hit) ? hit : [hit];
	};
}

const dns = fakeDns({
	"internal.corp": ["10.1.2.3"],
	"dual.host": ["93.184.216.34", "127.0.0.1"],
	"v6.name": ["2606:4700:4700::1111"],
	"meta.name": ["169.254.169.254"],
	localhost: ["127.0.0.1"],
	"router.internal": ["169.254.169.254"],
	"api.dev.local": ["169.254.169.254"],
	"example.com": ["93.184.216.34"],
	"ok.dev.local": ["203.0.113.10"],
	"lp.dev.local": ["127.0.0.1"],
	"empty.name": [],
});

function check(url: string, policy?: Parameters<typeof checkNavigationTarget>[1]) {
	return checkNavigationTarget(url, { lookup: dns, ...policy });
}

async function verdict(url: string, policy?: Parameters<typeof checkNavigationTarget>[1]) {
	const result = await check(url, policy);
	return result.allow ? "ALLOW" : `BLOCK:${result.code}`;
}

describe("navigation guard: private ranges (hermes _url_is_private parity)", () => {
	it("blocks RFC1918, loopback, CGNAT and unique-local literals", async () => {
		for (
			const url of [
				"http://10.0.0.5/x",
				"http://172.16.0.1",
				"http://172.31.255.255",
				"http://192.168.1.1",
				"http://127.0.0.1:9224/json",
				"http://127.1",
				"http://100.64.0.1",
				"http://100.127.255.255",
				"http://[::1]/",
				"http://[fd12:3456::1]/",
				"http://[fe80::1]/",
				"http://[2002:c0a8:1::]/",
				"http://2130706433/",
			]
		) {
			expect(await verdict(url), url).toBe("BLOCK:private");
		}
	});

	it("allows the boundary-adjacent public space", async () => {
		for (const url of ["http://172.15.0.1", "http://172.32.0.1", "http://100.128.0.1"]) {
			expect(await verdict(url), url).toBe("ALLOW");
		}
	});

	it("blocks internal-only name classes and names resolving privately", async () => {
		expect(await verdict("http://printer.local/x")).toBe("BLOCK:private");
		expect(await verdict("http://localhost:3000")).toBe("BLOCK:private");
		expect(await verdict("http://app.localhost")).toBe("BLOCK:private");
		expect(await verdict("http://internal.corp/")).toBe("BLOCK:private");
		// A public AND a private answer is private (any-record policy).
		expect(await verdict("http://dual.host/")).toBe("BLOCK:private");
	});

	it("allows public hosts and IPv6-only names", async () => {
		expect(await verdict("https://example.com/")).toBe("ALLOW");
		expect(await verdict("https://example.com:8443/path")).toBe("ALLOW");
		expect(await verdict("http://v6.name/")).toBe("ALLOW");
		// about: documents and scheme-less input (https fallback) stay allowed.
		expect(await verdict("about:blank")).toBe("ALLOW");
		expect(await verdict("example.com/public", { lookup: dns })).toBe("ALLOW");
	});
});

describe("navigation guard: cloud metadata floor (url_safety.py:488)", () => {
	it("blocks metadata targets even through relaxation", async () => {
		const urls = [
			"http://169.254.169.254/latest/meta-data",
			"http://[::ffff:169.254.169.254]/",
			"http://0xA9FEA9FE/",
			"https://metadata.google.internal/",
			"http://metadata.goog/",
			"http://meta.name/",
			// 169.254.169.254 in decimal form (the exact metadata address).
			"http://2852039166/",
		];
		for (const url of urls) expect(await verdict(url), url).toBe("BLOCK:metadata");
		for (const url of urls)
			expect(await verdict(url, { allowPrivateUrls: true }), `${url} relaxed`).toBe("BLOCK:metadata");
	});

	it("keeps allowlist entries from unblocking the floor", async () => {
		expect(await verdict("http://169.254.169.254/x", { privateUrlAllowlist: ["169.254.0.0/16"] })).toBe(
			"BLOCK:metadata",
		);
		// An allowlisted name that resolves to metadata still falls to the floor.
		expect(await verdict("http://api.dev.local/x", { privateUrlAllowlist: ["*.dev.local"] })).toBe("BLOCK:metadata");
	});
});

describe("navigation guard: schemes and malformed input", () => {
	it("blocks file:// by default and non-http(s) schemes always", async () => {
		expect(await verdict("file:///etc/passwd")).toBe("BLOCK:file");
		for (
			const url of [
				"data:text/html,<script>alert(1)</script>",
				"javascript:alert(1)",
				"chrome://settings",
				"view-source:http://10.0.0.5",
				"garbage::not a url",
				// scheme-less `localhost:9222/json` parses `localhost:` as an
				// opaque scheme; fail closed rather than guess.
				"localhost:9222/json",
			]
		) {
			expect(await verdict(url), url).toBe("BLOCK:scheme");
		}
	});

	it("rejects malformed IPv6 zone ids", async () => {
		expect(await verdict("http://[fe80::1%eth0]/")).toBe("BLOCK:malformed");
	});

	it("blocks credentials/secrets embedded in navigation targets", async () => {
		expect(await verdict("https://x.test/?k=sk-proj-abcdef1234567890ZZ")).toBe("BLOCK:secret-url");
	});

	it("explains the block to the model without leaking the allowlist", () => {
		const message = navigationBlockedMessage({
			allow: false,
			code: "private",
			target: "http://169.254.169.254/x",
			hostname: "169.254.169.254",
		});
		expect(message).toContain("private");
	});
});

describe("navigation guard: DNS posture", () => {
	it("blocks when resolution fails and when answers are empty", async () => {
		expect(await verdict("http://fail.name/")).toBe("BLOCK:dns");
		expect(await verdict("http://empty.name/")).toBe("BLOCK:dns");
	});

	it("trusts proxy env for the DNS failure (hermes proxy parity)", async () => {
		const previous = process.env.HTTPS_PROXY;
		process.env.HTTPS_PROXY = "http://proxy:8080";
		try {
			expect(await verdict("http://fail.name/")).toBe("ALLOW");
		} finally {
			if (previous === undefined) delete process.env.HTTPS_PROXY;
			else process.env.HTTPS_PROXY = previous;
		}
	});
});

describe("navigation guard: explicit relaxation", () => {
	it("allows exact hosts, wildcards, and endpoint ports through the allowlist", async () => {
		const policy = { privateUrlAllowlist: ["localhost", "127.0.0.1", "*.dev.local"] };
		expect(await verdict("http://localhost:3000", policy)).toBe("ALLOW");
		expect(await verdict("http://127.0.0.1:9224/json", policy)).toBe("ALLOW");
		// Wildcard match, then the resolved address decides (public here).
		expect(await verdict("http://ok.dev.local/x", policy)).toBe("ALLOW");
		// A wildcard entry relaxes the name class but never the resolved range…
		expect(await verdict("http://lp.dev.local/x", { privateUrlAllowlist: ["*.dev.local"] })).toBe("ALLOW");
	});

	it("allowPrivateUrls relaxes ordinary private ranges but not the floor or file://", async () => {
		const policy = { allowPrivateUrls: true };
		expect(await verdict("http://127.0.0.1:9224/json", policy)).toBe("ALLOW");
		expect(await verdict("http://localhost:3000", policy)).toBe("ALLOW");
		expect(await verdict("http://10.0.0.5/x", policy)).toBe("ALLOW");
		expect(await verdict("http://router.internal/x", policy)).toBe("BLOCK:metadata");
		expect(await verdict("http://169.254.169.254/x", policy)).toBe("BLOCK:metadata");
		expect(await verdict("file:///etc/passwd", policy)).toBe("BLOCK:file");
	});

	it("allows file:// only for the internal (read-pdf) exemption", async () => {
		expect(await verdict("file:///tmp/a.pdf", { allowFileUrls: true })).toBe("ALLOW");
	});
});

describe("navigation guard: post-commit fast path (DNS-free)", () => {
	it("flags always-blocked committed targets", () => {
		expect(isAlwaysBlockedNavigationTarget("http://169.254.169.254/x")).toBe(true);
		expect(isAlwaysBlockedNavigationTarget("http://[::ffff:169.254.169.254]:80/")).toBe(true);
		expect(isAlwaysBlockedNavigationTarget("http://localhost:9222")).toBe(true);
		expect(isAlwaysBlockedNavigationTarget("https://ok.example/x")).toBe(false);
		expect(isAlwaysBlockedNavigationTarget("http://8.8.8.8/")).toBe(false);
	});

	it("rechecks landed URLs without a resolver and honors relaxation", () => {
		// Metadata stays blocked under every relaxation.
		expect(isBlockedCommittedNavigation("http://169.254.169.254/x", { allowPrivateUrls: true })).toBe(true);
		expect(isBlockedCommittedNavigation("http://10.0.0.5/x")).toBe(true);
		expect(isBlockedCommittedNavigation("http://10.0.0.5/x", { allowPrivateUrls: true })).toBe(false);
		expect(isBlockedCommittedNavigation("http://127.0.0.1:9224/json")).toBe(true);
		expect(isBlockedCommittedNavigation("http://127.0.0.1:9224/json", { allowPrivateUrls: true })).toBe(false);
		expect(isBlockedCommittedNavigation("http://localhost/x")).toBe(true);
		expect(isBlockedCommittedNavigation("http://localhost/x", { allowPrivateUrls: true })).toBe(false);
		expect(isBlockedCommittedNavigation("http://localhost/x", { privateUrlAllowlist: ["localhost"] })).toBe(false);
		expect(isBlockedCommittedNavigation("https://ok.example/x")).toBe(false);
		// Hostnames that would need DNS are the pre-check's job; the fast path
		// deliberately does not re-resolve (redirect amplification).
		expect(isBlockedCommittedNavigation("http://internal.corp/x")).toBe(false);
		expect(isBlockedCommittedNavigation("about:blank")).toBe(false);
		expect(isBlockedCommittedNavigation("")).toBe(false);
		expect(isBlockedCommittedNavigation("file:///tmp/a.pdf")).toBe(true);
		expect(isBlockedCommittedNavigation("file:///tmp/a.pdf", { allowFileUrls: true })).toBe(false);
		expect(isBlockedCommittedNavigation("data:text/html,hi")).toBe(true);
	});
});

describe("navigation guard: policy resolution (explicit config only)", () => {
	it("env override wins in both directions", () => {
		expect(
			resolveNavigationPolicy({
				allowPrivateUrlsSetting: false,
				env: { PI_BROWSER_ALLOW_PRIVATE_URLS: "true" },
			}).allowPrivateUrls,
		).toBe(true);
		expect(
			resolveNavigationPolicy({
				allowPrivateUrlsSetting: true,
				env: { PI_BROWSER_ALLOW_PRIVATE_URLS: "false" },
			}).allowPrivateUrls,
		).toBe(false);
	});

	it("normalizes allowlist entries and merges configured endpoint hostnames", () => {
		const policy = resolveNavigationPolicy({
			allowlistSetting: ["Dev.Local", " ", 42],
			configuredEndpointUrls: ["http://127.0.0.1:9224", "ws://localhost:9222", undefined],
			env: {},
		});
		expect(policy.privateUrlAllowlist).toEqual(["dev.local", "127.0.0.1", "localhost"]);
	});
	it("classifies IPv4-mapped and zone-scoped addresses like the Python ipaddress module", () => {
		expect(classifyIpAddress("::ffff:100.100.100.200").alwaysBlocked).toBe(true);
		expect(classifyIpAddress("fe80::1%eth0").private).toBe(true);
		expect(classifyIpAddress("2606:4700:4700::1111").private).toBe(false);
		expect(classifyIpAddress("93.184.216.34").private).toBe(false);
		// An unparseable literal fails closed (private + always blocked).
		expect(classifyIpAddress("not-an-ip").private).toBe(true);
	});
});
