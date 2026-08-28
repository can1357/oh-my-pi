import { describe, expect, it } from "bun:test";
import { HeaderGenerator, type Headers, type OperatingSystem } from "@oh-my-pi/pi-utils/headers";

// Captured from header-generator 2.1.82 for desktop navigation requests. Client hints
// are the three additional fields emitted for Chromium profiles.
const GOLDEN_NAVIGATION_FIELDS = [
	"accept",
	"accept-encoding",
	"accept-language",
	"sec-fetch-dest",
	"sec-fetch-mode",
	"sec-fetch-site",
	"sec-fetch-user",
	"upgrade-insecure-requests",
	"user-agent",
];
const GOLDEN_CHROMIUM_FIELDS = [
	...GOLDEN_NAVIGATION_FIELDS,
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
].sort();

function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function sortedFields(headers: Headers): string[] {
	return Object.keys(headers).sort();
}

describe("HeaderGenerator", () => {
	it("matches the original navigation field sets", () => {
		const commonOptions = {
			devices: ["desktop"] as ["desktop"],
			operatingSystems: ["windows", "macos", "linux"] as OperatingSystem[],
		};
		const chrome = new HeaderGenerator({ ...commonOptions, browsers: ["chrome"], rng: seeded(1) }).getHeaders();
		const firefox = new HeaderGenerator({ ...commonOptions, browsers: ["firefox"], rng: seeded(1) }).getHeaders();
		const safari = new HeaderGenerator({ ...commonOptions, browsers: ["safari"], rng: seeded(1) }).getHeaders();

		expect(sortedFields(chrome)).toEqual(GOLDEN_CHROMIUM_FIELDS);
		expect(sortedFields(firefox)).toEqual(GOLDEN_NAVIGATION_FIELDS);
		expect(sortedFields(safari)).toEqual(GOLDEN_NAVIGATION_FIELDS);
	});

	it("keeps user agents, client hints, and operating systems coherent across 100 draws", () => {
		const generator = new HeaderGenerator({
			browserListQuery: "last 3 versions",
			devices: ["desktop"],
			operatingSystems: ["windows", "macos", "linux"],
			locales: ["en-US", "en"],
			rng: seeded(0xc0ffee),
		});
		const seen = new Set<string>();

		for (let index = 0; index < 100; index++) {
			const headers = generator.getHeaders();
			const userAgent = headers["user-agent"] ?? "";
			if (userAgent.includes("Chrome/")) {
				seen.add("chrome");
				const version = userAgent.match(/Chrome\/(\d+)/)?.[1];
				expect(version).toBeDefined();
				expect(headers["sec-ch-ua"]).toContain(`"Google Chrome";v="${version}"`);
				expect(headers["sec-ch-ua"]).toContain(`"Chromium";v="${version}"`);
				expect(headers["sec-ch-ua-mobile"]).toBe("?0");
				if (userAgent.includes("Windows NT")) expect(headers["sec-ch-ua-platform"]).toBe('"Windows"');
				if (userAgent.includes("Macintosh")) expect(headers["sec-ch-ua-platform"]).toBe('"macOS"');
				if (userAgent.includes("Linux")) expect(headers["sec-ch-ua-platform"]).toBe('"Linux"');
			} else if (userAgent.includes("Firefox/")) {
				seen.add("firefox");
				expect(headers["sec-ch-ua"]).toBeUndefined();
				expect(userAgent.match(/rv:(\d+)\.0/)?.[1]).toBe(userAgent.match(/Firefox\/(\d+)\.0/)?.[1]);
			} else {
				seen.add("safari");
				expect(userAgent).toContain("Macintosh");
				expect(userAgent).toContain("Version/26.");
				expect(headers["sec-ch-ua"]).toBeUndefined();
			}
		}

		expect(seen).toEqual(new Set(["chrome", "firefox", "safari"]));
	});

	it("honors locales and request overrides", () => {
		const headers = new HeaderGenerator({ browsers: ["firefox"], locales: ["fr-CA", "fr", "en"] }).getHeaders(
			undefined,
			{ accept: "application/json", cookie: "session=abc" },
		);

		expect(headers["accept-language"]).toBe("fr-CA,fr;q=0.9,en;q=0.8");
		expect(headers.accept).toBe("application/json");
		expect(headers.cookie).toBe("session=abc");
	});

	it("is deterministic with identical seeded RNGs", () => {
		const first = new HeaderGenerator({ rng: seeded(42) });
		const second = new HeaderGenerator({ rng: seeded(42) });
		for (let index = 0; index < 25; index++) {
			expect(first.getHeaders()).toEqual(second.getHeaders());
		}
	});
});
