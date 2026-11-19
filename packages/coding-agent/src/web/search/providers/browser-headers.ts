import { HeaderGenerator } from "@oh-my-pi/pi-utils/headers";

const generator = new HeaderGenerator({
	browserListQuery: "last 3 versions",
	devices: ["desktop"],
	operatingSystems: ["windows", "macos", "linux"],
	locales: ["en-US", "en"],
	httpVersion: "2",
	strict: false,
});

// A fallback desktop Mac Chrome navigation fingerprint matching
// the previous static default setup for deterministic or non-randomized calls.
const CHROME_FALLBACK_HEADERS: Record<string, string> = {
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "max-age=0",
	Priority: "u=0, i",
	"Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"macOS"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

function canonicalizeHeaderNames(headers: Record<string, string>): Record<string, string> {
	const canonicalized: Record<string, string> = {};

	for (const key in headers) {
		const value = headers[key];
		if (value === undefined) continue;

		// Retain Client Hints (sec-ch-ua*) in their standard lower-case representation
		if (key.startsWith("sec-ch-ua")) {
			canonicalized[key] = value;
			continue;
		}

		// Retain diagnostics or other HTTP/2 custom lower-case keys
		if (["dnt", "rtt", "ect"].includes(key)) {
			canonicalized[key.toUpperCase()] = value;
			continue;
		}

		// Retain HTTP/2 specific pseudo headers if any, or general standard casing overrides
		if (key === "te") {
			canonicalized.TE = value;
			continue;
		}

		// Pascalize words separated by hyphens (e.g. accept-language -> Accept-Language)
		const pascalized = key
			.split("-")
			.map(part => (part[0] ? part[0].toUpperCase() + part.slice(1).toLowerCase() : ""))
			.join("-");

		canonicalized[pascalized] = value;
	}

	return canonicalized;
}

/**
 * Build a fresh, internally consistent desktop navigation fingerprint for one HTTP request.
 * By default, this randomizes across coherent modern Chrome, Firefox, and Safari profiles.
 * Set `randomized` to `false` when a fetch must preserve a stable Mac Chrome identity.
 */
export function buildBrowserNavigationHeaders(options?: { randomized?: boolean }): Record<string, string> {
	const randomized = options?.randomized !== false;
	if (!randomized) {
		return { ...CHROME_FALLBACK_HEADERS };
	}

	return canonicalizeHeaderNames(generator.getHeaders());
}
