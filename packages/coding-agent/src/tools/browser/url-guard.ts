/**
 * SSRF / private-network navigation guard for the browser tool.
 *
 * Ported from `hermes-agent` (`tools/url_safety.py`, `tools/browser_tool.py`
 * `_url_is_private` + `evaluate_url_safety`), Copyright (c) 2025 Nous Research
 * — MIT License. See ./NOTICE for the full attribution and the list of
 * deliberate deltas for the oh-my-pi port.
 *
 * Threat model: the browser runs inside the owner's trust boundary (local
 * headless Chromium, a spawned app, the owner's Chrome via the omp relay, or a
 * CDP endpoint on the LAN). A prompt-injected page — or a page that merely
 * redirects — can drive the tool's own navigation API at internal addresses:
 * cloud credential endpoints (`169.254.169.254`, `metadata.google.internal`),
 * router admin panels, unauthenticated dev services on loopback, or internal
 * LAN ranges — and then exfiltrate the response body through `tab.observe()` /
 * `tab.extract()` / `page.evaluate()`. This module is the navigation-side half
 * of the defense; the output-side half is ./output-redact.ts.
 *
 * Check order (hermes `is_safe_url` parity, url_safety.py:415-519):
 *  1. credential-shaped tokens in the URL block outright (`evaluate_url_safety`);
 *  2. scheme rules: http(s) proceed; `about:` allowed; `file:` internal-exempt
 *     only; anything else blocked (:430-432);
 *  3. the always-blocked floor survives EVERY relaxation and is checked with no
 *     DNS round-trip: the metadata hostnames `metadata.google.internal` /
 *     `metadata.goog` (:166-169), the whole 169.254.0.0/16 link-local range
 *     (IPv4 + `::ffff:` mapped), the named metadata addresses 169.254.170.2,
 *     169.254.169.253, fd00:ec2::254, 100.100.100.200 (:180-195);
 *  4. explicit relaxation (`allowPrivateUrls` toggle, allowlist entry, or an
 *     endpoint host the user configured themselves): relaxes the ORDINARY
 *     private classes — 10/8, 172.16/12, 192.168/16, 127/8, ::1, fc00::/7,
 *     fe80::/10, CGNAT 100.64/10, reserved/multicast/unspecified, and the
 *     obvious-private name classes (localhost, *.localhost, *.lan, *.local,
 *     *.internal, *.home.arpa — browser_tool.py:1427-1430 short-circuit) —
 *     never the floor;
 *  5. otherwise: literal IPs are classified directly; hostnames are resolved
 *     (every answer classified, mirroring the getaddrinfo loop) — a public
 *     answer passes, any private/metadata answer blocks.
 *
 * It FAILS CLOSED: DNS failure, empty answers, unparseable addresses,
 * malformed URLs and any unexpected error all block (:449-485, :515-519). The
 * one ported carve-out is hermes' proxy-delegation case: when an HTTP(S)/ALL
 * proxy env var is configured, a DNS failure allows the navigation because the
 * proxy — not this process — resolves the name (:450-472).
 *
 * Deltas vs hermes (see NOTICE):
 *  - `new URL()` (WHATWG/Ada) replaces `urlparse`: it already normalizes
 *    numeric host forms (`http://2130706433` → `127.0.0.1`,
 *    `http://0xA9FEA9FE` → `169.254.169.254`, `http://127.1`), unicode
 *    hostnames to punycode, case and trailing dots — the classic notation
 *    bypasses die at the parser; the RESULTING hostname is what gets checked.
 *  - The guard classifies the resolved IP like hermes `is_safe_url`; hermes'
 *    fail-OPEN `_url_is_private` (:1433-1434, routing hint only) is NOT ported
 *    — omp has only one browser routing path, so one guard suffices.
 *  - hermes' cloud-sidecar routing (`_auto_local_for_private_urls`,
 *    `_navigation_session_key`) and the "third-party reader" sensitive-query
 *    block are NOT ported: every omp browser is the user's own local browser,
 *    so there is no foreign reader to route around. Credential *shapes* in
 *    navigation URLs are still blocked outright, and the output-side redactor
 *    keeps the rest out of transcripts.
 *  - DNS rebinding: hermes closes the check-vs-connect TOCTOU window only on
 *    its own httpx paths by pinning the resolved IP at connect time
 *    (`create_ssrf_safe_client`). A CDP/puppeteer navigation cannot pin
 *    connections, so the window remains: a hostile DNS record answering public
 *    at check time and flipping to `127.0.0.1` before Chromium connects still
 *    reaches the loopback service. The mitigation available here is the
 *    post-commit recheck (`isAlwaysBlockedNavigationTarget` + the worker's
 *    `framenavigated` observer): the committed URL is re-validated, the
 *    navigation stopped, the page pulled back to `about:blank`, and the run's
 *    output discarded so the fetched content never reaches the model.
 *    Honestly: content suppression, not prevention.
 *  - The relay/CDP *transport* (`wsEndpoint`, e.g. `127.0.0.1:9224`) never
 *    passes through this module: the guard inspects navigation TARGETS only,
 *    so `app.relay` sessions keep driving the owner's Chrome unchanged; the
 *    configured endpoint host additionally joins the allowlist via
 *    `resolveNavigationPolicy` (the contract's "explicit-relay allow").
 */

import { promises as nodeDns } from "node:dns";

import { containsSecretTokenShape } from "./output-redact";

/** Hostname resolver seam: returns every address a hostname resolves to. */
export type HostnameResolver = (hostname: string) => Promise<string[]>;

/** Serializable navigation-guard policy. Plain data: crosses worker boundaries. */
export interface NavigationGuardPolicy {
	/** Relax the ordinary private ranges (never the always-blocked metadata floor). */
	readonly allowPrivateUrls?: boolean;
	/**
	 * Explicit host allowlist: exact hostnames, `*.suffix` wildcards, IP
	 * literals, or CIDR prefixes. Populated ONLY from configuration (settings
	 * keys or an endpoint the user configured) — never derived from page content.
	 */
	readonly privateUrlAllowlist?: readonly string[];
	/**
	 * Internal-only exemption for first-party Chromium document rendering
	 * (read-pdf hands a local file:// to the built-in PDF viewer). Set by a
	 * call site in the harness, never by settings, env, or page content.
	 */
	readonly allowFileUrls?: boolean;
	/** Injectable DNS resolver (tests, sandboxes). Defaults to `node:dns`. */
	readonly lookup?: HostnameResolver;
}

export type NavigationVerdict =
	| { readonly allow: true }
	| {
			readonly allow: false;
			readonly code: "file" | "scheme" | "metadata" | "private" | "secret-url" | "dns" | "malformed";
			readonly target: string;
			readonly hostname?: string;
			readonly detail?: string;
	  };

const PROXY_ENV_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

/** Cloud metadata hostnames blocked without any DNS lookup (url_safety.py:166-169). */
const ALWAYS_BLOCKED_HOSTNAMES: Record<string, true> = {
	"metadata.google.internal": true,
	"metadata.goog": true,
};

/**
 * Obvious-private name classes: no DNS round-trip needed to know they are
 * internal-only (browser_tool.py:1427-1430). Unlike the metadata floor these
 * relax through explicit config.
 */
const PRIVATE_HOST_SUFFIXES = [".localhost", ".lan", ".local", ".internal", ".home.arpa"] as const;

function ip4(dotted: string): number {
	let value = 0;
	for (const part of dotted.split(".")) value = value * 256 + Number.parseInt(part, 10);
	return value >>> 0;
}

/**
 * The always-blocked metadata floor as IPv4 addresses (url_safety.py:180-188).
 * `::ffff:`-mapped spellings are unwrapped before this check, so one list
 * covers both (hermes lists them separately; the unwrap is the omp delta).
 */
const ALWAYS_BLOCKED_V4_EXACT: readonly number[] = [
	ip4("169.254.169.254"), // AWS/GCP/Azure/DO/Oracle instance metadata
	ip4("169.254.170.2"), // AWS ECS task metadata (task IAM creds)
	ip4("169.254.169.253"), // Azure IMDS wire server
	ip4("100.100.100.200"), // Alibaba Cloud metadata
];

/** IPv4 CIDRs blocked even under every relaxation (:192-195). */
const ALWAYS_BLOCKED_V4_NETWORKS: readonly [number, number][] = [[ip4("169.254.0.0"), 16]];

/** Always-blocked IPv6 literals (only meaningful as pure-v6 addresses). */
const ALWAYS_BLOCKED_V6_TEXT: readonly string[] = ["fd00:ec2::254"]; // AWS metadata (IPv6)

/** Private/loopback/link-local/reserved/multicast IPv4 CIDRs (:289-308 + Python is_private table). */
const PRIVATE_V4_NETWORKS: readonly [number, number][] = [
	[ip4("0.0.0.0"), 8], // "this host"
	[ip4("10.0.0.0"), 8],
	[ip4("100.64.0.0"), 10], // CGNAT (RFC 6598) — not covered by Python is_private
	[ip4("127.0.0.0"), 8],
	[ip4("169.254.0.0"), 16],
	[ip4("172.16.0.0"), 12],
	[ip4("192.0.0.0"), 24],
	[ip4("192.0.2.0"), 24], // TEST-NET-1
	[ip4("192.88.99.0"), 24], // 6to4 relay anycast
	[ip4("192.168.0.0"), 16],
	[ip4("198.18.0.0"), 15], // benchmarking
	[ip4("198.51.100.0"), 24], // TEST-NET-2
	[ip4("203.0.113.0"), 24], // TEST-NET-3
	[ip4("224.0.0.0"), 4], // multicast
	[ip4("240.0.0.0"), 4], // reserved + broadcast
];

function bytesFromHex(hex: string): Uint8Array {
	const bytes = new Uint8Array(16);
	let group = 0;
	for (let i = 0; i < hex.length; i += 4) {
		const value = Number.parseInt(hex.slice(i, i + 4), 16);
		bytes[group * 2] = value >> 8;
		bytes[group * 2 + 1] = value & 0xff;
		group++;
	}
	return bytes;
}

/** Private/loopback/link-local/ULA/multicast IPv6 prefixes (Python is_private/is_loopback/is_link_local/is_reserved/is_multicast). */
const PRIVATE_V6_NETWORKS: readonly [Uint8Array, number][] = [
	[bytesFromHex("00000000000000000000000000000000"), 128], // unspecified ::
	[bytesFromHex("00000000000000000000000000000001"), 128], // loopback ::1
	[bytesFromHex("0064ff9b000000000000000000000000"), 96], // NAT64 well-known prefix — reaches v4 destinations
	[bytesFromHex("01000000000000000000000000000000"), 64], // discard-only 100::/64
	[bytesFromHex("fc000000000000000000000000000000"), 7], // unique local fc00::/7
	[bytesFromHex("fe800000000000000000000000000000"), 10], // link-local fe80::/10
	[bytesFromHex("ff000000000000000000000000000000"), 12], // multicast ff00::/12
	[bytesFromHex("20010db8000000000000000000000000"), 32], // documentation 2001:db8::/32
];

/** Parse an IPv4 dotted-quad to a 32-bit number, or `undefined` when not IPv4. */
function parseIpv4(host: string): number | undefined {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!match) return undefined;
	let value = 0;
	for (let i = 1; i <= 4; i++) {
		const octet = Number(match[i]);
		if (octet > 255) return undefined;
		value = value * 256 + octet;
	}
	return value >>> 0;
}

/**
 * Parse an IPv6 address (with optional brackets, `%zone`, and embedded IPv4)
 * into 16 bytes, or `undefined` when the host is not a valid IPv6 literal.
 */
function parseIpv6(host: string): Uint8Array | undefined {
	let text = host;
	if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
	const zone = text.indexOf("%");
	if (zone !== -1) text = text.slice(0, zone); // scope id (fe80::1%eth0)
	if (!text.includes(":")) return undefined;
	const halves = text.split("::");
	if (halves.length > 2) return undefined;
	const parseGroups = (part: string): number[] | undefined => {
		if (part.length === 0) return [];
		const groups: number[] = [];
		for (const token of part.split(":")) {
			if (token.includes(".")) {
				const embedded = parseIpv4(token);
				if (embedded === undefined) return undefined;
				groups.push((embedded >>> 16) & 0xffff, embedded & 0xffff);
			} else {
				if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return undefined;
				groups.push(Number.parseInt(token, 16));
			}
		}
		return groups;
	};
	if (halves.length === 2) {
		const [headText, tailText] = halves as [string, string];
		const head = parseGroups(headText);
		const tail = parseGroups(tailText);
		if (!head || !tail) return undefined;
		const fill = 8 - head.length - tail.length;
		if (fill < 0) return undefined;
		return groupsToBytes([...head, ...new Array<number>(fill).fill(0), ...tail]);
	}
	const groups = parseGroups(halves[0] ?? "");
	if (!groups || groups.length !== 8) return undefined;
	return groupsToBytes(groups);
}

function groupsToBytes(groups: readonly number[]): Uint8Array {
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i++) {
		const group = groups[i] ?? 0;
		bytes[i * 2] = group >> 8;
		bytes[i * 2 + 1] = group & 0xff;
	}
	return bytes;
}

function inCidr4(value: number, base: number, bits: number): boolean {
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function inCidrs4(value: number, cidrs: readonly [number, number][]): boolean {
	for (const [base, bits] of cidrs) if (inCidr4(value, base, bits)) return true;
	return false;
}

function inCidr6(bytes: Uint8Array, base: Uint8Array, bits: number): boolean {
	for (let i = 0; i < 16; i++) {
		const remaining = bits - i * 8;
		if (remaining <= 0) return true;
		const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
		if (((bytes[i] ?? 0) & mask) !== ((base[i] ?? 0) & mask)) return false;
	}
	return true;
}

function inCidrs6(bytes: Uint8Array, cidrs: readonly [Uint8Array, number][]): boolean {
	for (const [base, bits] of cidrs) if (inCidr6(bytes, base, bits)) return true;
	return false;
}

/** Extract the embedded IPv4 of `::ffff:a.b.c.d` / `::a.b.c.d` forms. */
function embeddedV4(bytes: Uint8Array): number | undefined {
	for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return undefined;
	const mapped = (bytes[10] ?? 0) === 0xff && (bytes[11] ?? 0) === 0xff;
	const compatible = (bytes[10] ?? 0) === 0 && (bytes[11] ?? 0) === 0;
	if (!mapped && !compatible) return undefined;
	return ((bytes[12] ?? 0) * 16777216 + (bytes[13] ?? 0) * 65536 + (bytes[14] ?? 0) * 256 + (bytes[15] ?? 0)) >>> 0;
}

/** 2002::/16 (6to4) carries an IPv4 in bytes 2..5. */
function sixToFourV4(bytes: Uint8Array): number | undefined {
	if (bytes[0] !== 0x20 || bytes[1] !== 0x02) return undefined;
	return ((bytes[2] ?? 0) * 16777216 + (bytes[3] ?? 0) * 65536 + (bytes[4] ?? 0) * 256 + (bytes[5] ?? 0)) >>> 0;
}

function alwaysBlockedV4(value: number): boolean {
	if (ALWAYS_BLOCKED_V4_EXACT.includes(value)) return true;
	return inCidrs4(value, ALWAYS_BLOCKED_V4_NETWORKS);
}

/**
 * Classify one IP literal. `::ffff:`-mapped, IPv4-compatible, and 6to4
 * (2002::/16) forms are unwrapped so an IPv6 spelling of a blocked IPv4
 * address cannot smuggle past the checks (url_safety.py:291-298 lists the
 * mapped variants explicitly). An unparseable literal reports
 * private+alwaysBlocked: fail closed.
 */
export function classifyIpAddress(ip: string): {
	readonly kind: "v4" | "v6";
	readonly private: boolean;
	readonly alwaysBlocked: boolean;
} {
	const normalized = stripBrackets(ip);
	const v4 = parseIpv4(normalized);
	if (v4 !== undefined) {
		return {
			kind: "v4",
			private: inCidrs4(v4, PRIVATE_V4_NETWORKS),
			alwaysBlocked: alwaysBlockedV4(v4),
		};
	}
	const v6 = parseIpv6(normalized);
	if (!v6) return { kind: "v6", private: true, alwaysBlocked: true };
	const embedded = embeddedV4(v6) ?? sixToFourV4(v6);
	if (embedded !== undefined) {
		// `::ffff:x.x.x.x` / `::x.x.x.x` / `2002:x.x.x.x.*`: judged by the
		// embedded IPv4 — incl. the mapped link-local metadata floor
		// (`::ffff:169.254.0.0/112` in hermes terms).
		return {
			kind: "v6",
			private: inCidrs4(embedded, PRIVATE_V4_NETWORKS),
			alwaysBlocked: alwaysBlockedV4(embedded),
		};
	}
	return {
		kind: "v6",
		private: inCidrs6(v6, PRIVATE_V6_NETWORKS),
		alwaysBlocked: ALWAYS_BLOCKED_V6_TEXT.some(literal => {
			const base = parseIpv6(literal);
			return !!base && bytesToHexGroupText(v6) === bytesToHexGroupText(base);
		}),
	};
}

function bytesToHexGroupText(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < 16; i += 2)
		out += ((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)) >>> 0).toString(16).padStart(4, "0");
	return out;
}

function stripBrackets(host: string): string {
	let text = host;
	if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
	const zone = text.indexOf("%");
	return zone === -1 ? text : text.slice(0, zone);
}

/** Split `host:port` (bracket-aware) into canonical lowercase host + port. */
function splitHostPort(input: string): { hostname: string; port: string } {
	const text = input.trim();
	if (text.startsWith("[")) {
		const end = text.indexOf("]");
		if (end === -1) return { hostname: text.toLowerCase(), port: "" };
		const rest = text.slice(end + 1);
		return { hostname: text.slice(0, end + 1).toLowerCase(), port: rest.startsWith(":") ? rest.slice(1) : "" };
	}
	const colon = text.indexOf(":");
	if (colon !== -1 && text.indexOf(":", colon + 1) === -1) {
		return { hostname: text.slice(0, colon).toLowerCase(), port: text.slice(colon + 1) };
	}
	return { hostname: text.toLowerCase(), port: "" };
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/\.+$/, "");
}

/**
 * Match a normalized hostname (and optional `host:port`) against an explicit
 * allowlist entry: exact hostname, exact `host:port`, `*.suffix` wildcard,
 * bare IP literal, or CIDR prefix. Entries come from configuration only.
 */
export function matchesAllowlistEntry(hostname: string, port: string, entry: string): boolean {
	const normalized = entry.trim().toLowerCase().replace(/\.+$/, "");
	if (!normalized) return false;
	if (normalized.includes("/")) {
		const [baseText, bitsText] = normalized.split("/");
		const bits = Number.parseInt(bitsText ?? "", 10);
		if (!Number.isFinite(bits)) return false;
		const base4 = baseText !== undefined ? parseIpv4(baseText) : undefined;
		if (base4 !== undefined) {
			const host4 = parseIpv4(hostname);
			return host4 !== undefined && inCidr4(host4, base4, bits);
		}
		const base6 = baseText !== undefined ? parseIpv6(baseText) : undefined;
		const host6 = parseIpv6(hostname);
		return !!base6 && !!host6 && inCidr6(host6, base6, bits);
	}
	if (normalized.startsWith("*.")) {
		const suffix = normalized.slice(2);
		return hostname === suffix || hostname.endsWith(`.${suffix}`);
	}
	const { hostname: entryHost, port: entryPort } = splitHostPort(normalized);
	if (entryPort && entryPort !== port) return false;
	return normalizeHostname(entryHost) === hostname;
}

function proxyIsConfigured(): boolean {
	for (const name of PROXY_ENV_VARS) if (process.env[name]) return true;
	return false;
}

/** Default resolver: every `node:dns` answer, mirroring hermes' getaddrinfo loop. */
const dnsResolver: HostnameResolver = async hostname => {
	const answers = await nodeDns.lookup(hostname, { all: true, verbatim: true });
	return answers.map(answer => answer.address);
};

/** `localhost`, `app.localhost`, `printer.lan`, … — internal by name alone. */
function hostnameIsPrivateByName(hostname: string): boolean {
	if (hostname === "localhost") return true;
	for (const suffix of PRIVATE_HOST_SUFFIXES) if (hostname.endsWith(suffix)) return true;
	return false;
}

type ParsedTarget =
	| {
			readonly kind: "host";
			readonly scheme: "http" | "https";
			readonly hostname: string;
			readonly port: string;
			readonly ipText?: string;
	  }
	| { readonly kind: "opaque"; readonly scheme: string };

/**
 * Parse + normalize a navigation target. WHATWG URL normalization is the first
 * bypass layer: numeric host forms, punycode, case folding and trailing dots
 * all canonicalize before any range check runs. Only http/https ever come back
 * as `host` targets — every other scheme (chrome:, view-source:, ws:, ftp:,
 * even a host-carrying `chrome://settings`) is classified opaquely so the
 * scheme rule cannot be bypassed by a scheme Chromium parses specially.
 */
function parseTarget(raw: string): ParsedTarget | undefined {
	let text = raw.trim();
	if (!text) return undefined;
	// Repair the "https:// host.example" artifact hermes fixes the same way
	// (url_safety.py:74-79): whitespace after the scheme separator is never legal.
	text = text.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)\s+/, "$1");
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		// Scheme-less strings ("example.com/page") get the same interpretation
		// Chromium gives them: as https. A string that already carries a scheme
		// and still fails to parse stays malformed — fail closed. (IPv6 zone
		// ids like `http://[fe80::1%eth0]/` land here: WHATWG rejects them and
		// so does Chromium's URL pipeline for CDP-driven navigation, so
		// blocking is the honest verdict.)
		if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return undefined;
		try {
			url = new URL(`https://${text}`);
		} catch {
			return undefined;
		}
	}
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	if (scheme !== "http" && scheme !== "https") return { kind: "opaque", scheme };
	if (!url.hostname) return undefined; // `http://` with no host
	const hostname = normalizeHostname(url.hostname);
	const bare = stripBrackets(hostname);
	let ipText: string | undefined;
	if (parseIpv4(bare) !== undefined || parseIpv6(bare) !== undefined) ipText = bare;
	return { kind: "host", scheme, hostname, port: url.port, ipText };
}

/**
 * The guard entry point: classify one navigation target against `policy`.
 * Fails closed on every error path (see module header).
 */
export async function checkNavigationTarget(raw: string, policy: NavigationGuardPolicy = {}): Promise<NavigationVerdict> {
	try {
		if (containsSecretTokenShape(raw) || containsSecretTokenShape(safeDecode(raw))) {
			return { allow: false, code: "secret-url", target: raw, detail: "URL carries a credential-shaped token" };
		}
		const parsed = parseTarget(raw);
		if (!parsed) return { allow: false, code: "malformed", target: raw };
		if (parsed.kind === "opaque") {
			if (parsed.scheme === "about") return { allow: true };
			if (parsed.scheme === "file")
				return policy.allowFileUrls ? { allow: true } : { allow: false, code: "file", target: raw };
			return { allow: false, code: "scheme", target: raw, detail: parsed.scheme };
		}
		const hostname = parsed.hostname;
		// Metadata hostnames: always-blocked floor, no DNS, survives every toggle
		// and the allowlist.
		if (ALWAYS_BLOCKED_HOSTNAMES[hostname] === true) {
			return { allow: false, code: "metadata", target: raw, hostname };
		}
		// Literal IPs: the metadata floor is judged BEFORE any relaxation.
		if (parsed.ipText) {
			const classification = classifyIpAddress(parsed.ipText);
			if (classification.alwaysBlocked) return { allow: false, code: "metadata", target: raw, hostname };
			if (policy.allowPrivateUrls === true || isAllowlisted(hostname, parsed.port, policy)) return { allow: true };
			if (classification.private) return { allow: false, code: "private", target: raw, hostname };
			return { allow: true };
		}
		const privateByName = hostnameIsPrivateByName(hostname);
		const relaxed = policy.allowPrivateUrls === true || isAllowlisted(hostname, parsed.port, policy);
		// Obvious-private names need no DNS round-trip to know they are internal
		// (browser_tool.py:1427-1430) — but under relaxation they still fall
		// through to resolution + floor check below, because hermes enforces the
		// metadata floor on the RESOLVED address even with the toggle on
		// (url_safety.py:488): `api.dev.local -> 169.254.169.254` stays blocked.
		if (privateByName && !relaxed) {
			return { allow: false, code: "private", target: raw, hostname };
		}

		// Resolved-IP classification (also under relaxation, hermes
		// url_safety.py:410-413: a safe-listed name resolving into the
		// always-blocked range stays blocked; under `allowPrivateUrls` only the
		// floor is enforced).
		const resolver = policy.lookup ?? dnsResolver;
		let answers: string[];
		try {
			answers = await resolver(hostname);
		} catch {
			// hermes is_safe_url:448-474 — fail closed, except the
			// proxy-delegation carve-out (the proxy resolves the name).
			if (proxyIsConfigured()) return { allow: true };
			return { allow: false, code: "dns", target: raw, hostname, detail: "DNS resolution failed" };
		}
		if (!answers.length) {
			if (relaxed) return { allow: true };
			return { allow: false, code: "dns", target: raw, hostname, detail: "no DNS answers" };
		}
		for (const answer of answers) {
			const address = answer.includes("%") ? (answer.split("%")[0] ?? answer) : answer;
			const classification = classifyIpAddress(address);
			if (classification.alwaysBlocked) return { allow: false, code: "metadata", target: raw, hostname };
			if (relaxed) continue;
			if (classification.private) return { allow: false, code: "private", target: raw, hostname };
		}
		return { allow: true };
	} catch (error) {
		// Fail closed on unexpected errors — parsing edge cases must not become
		// bypass vectors (url_safety.py:515-519).
		return { allow: false, code: "malformed", target: raw, detail: error instanceof Error ? error.message : String(error) };
	}
}

function isAllowlisted(hostname: string, port: string, policy: NavigationGuardPolicy): boolean {
	return (policy.privateUrlAllowlist ?? []).some(entry => matchesAllowlistEntry(hostname, port, entry));
}

function safeDecode(text: string): string {
	let current = text;
	for (let i = 0; i < 3; i++) {
		try {
			const next = decodeURIComponent(current);
			if (next === current) break;
			current = next;
		} catch {
			break;
		}
	}
	return current;
}

/**
 * Cheap, DNS-free classification of an already-committed URL — the
 * post-navigation recheck seam. Literal IPs and the always-blocked hostname
 * set are classified exactly, plus the private-by-name classes. Returns false
 * for hostnames that would need a resolver (the async pre-check owns that
 * path) and for malformed input (a committed `page.url()` is already
 * normalized by Chromium; a parse failure here is not a metadata endpoint).
 */
export function isAlwaysBlockedNavigationTarget(url: string): boolean {
	const parsed = parseTarget(url);
	if (!parsed || parsed.kind !== "host") return false;
	if (ALWAYS_BLOCKED_HOSTNAMES[parsed.hostname] === true) return true;
	if (parsed.ipText) return classifyIpAddress(parsed.ipText).alwaysBlocked;
	return hostnameIsPrivateByName(parsed.hostname);
}

/**
 * Policy-aware, DNS-free check of an ALREADY-COMMITTED navigation (redirect /
 * client-side nav / new-tab adoption): true = the page landed somewhere it
 * must not show the model. Same ordering as the async pre-check minus
 * resolution: the metadata floor survives every relaxation; ordinary private
 * ranges and private-by-name hosts block unless `allowPrivateUrls` or an
 * allowlist entry covers them; hostnames that would need DNS are allowed
 * here (the pre-check already vetted them; re-resolving per commit would
 * multiply DNS traffic on redirect chains). Non-http(s) commits (`file:`,
 * `chrome:`) violate unless internally exempted by `allowFileUrls`.
 */
export function isBlockedCommittedNavigation(url: string, policy: NavigationGuardPolicy = {}): boolean {
	const parsed = parseTarget(url);
	if (!parsed) return false; // Chromium-normalized URLs parse; unparseable is not a private target
	if (parsed.kind === "opaque") {
		if (parsed.scheme === "about") return false;
		if (parsed.scheme === "file") return policy.allowFileUrls !== true;
		return true;
	}
	if (ALWAYS_BLOCKED_HOSTNAMES[parsed.hostname] === true) return true;
	const relaxed = policy.allowPrivateUrls === true || isAllowlisted(parsed.hostname, parsed.port, policy);
	if (parsed.ipText) {
		const classification = classifyIpAddress(parsed.ipText);
		if (classification.alwaysBlocked) return true;
		return !relaxed && classification.private;
	}
	if (relaxed) return false;
	return hostnameIsPrivateByName(parsed.hostname);
}

/** Model-facing explanation with the exact remediation for a blocked verdict. */
export function navigationBlockedMessage(verdict: NavigationVerdict): string {
	if (verdict.allow) return "";
	switch (verdict.code) {
		case "file":
			return `Blocked: navigating to ${JSON.stringify(verdict.target)} uses file://, which the browser tool does not allow. Serve the content over http(s) or open it with the read tool instead.`;
		case "scheme":
			return `Blocked: the ${JSON.stringify(verdict.detail ?? "")} scheme is not allowed for browser navigation (http/https only).`;
		case "metadata":
			return `Blocked: ${JSON.stringify(verdict.hostname ?? verdict.target)} is a cloud metadata endpoint and is never navigable.`;
		case "private":
			return `Blocked: ${JSON.stringify(verdict.hostname ?? verdict.target)} is a private/internal address${verdict.detail ? ` (${verdict.detail})` : ""}. To allow specific hosts, set browser.privateUrlAllowlist (e.g. ["localhost", "127.0.0.1", "*.dev.local"]); to relax the whole range, set browser.allowPrivateUrls: true. Cloud metadata endpoints stay blocked either way.`;
		case "secret-url":
			return "Blocked: URL contains what appears to be an API key or token. Secrets must not be sent in URLs.";
		case "dns":
			return `Blocked: ${JSON.stringify(verdict.hostname ?? verdict.target)} could not be resolved (${verdict.detail ?? "DNS error"}); navigation fails closed.`;
		case "malformed":
			return `Blocked: ${JSON.stringify(verdict.target)} is not a navigable URL${verdict.detail ? ` (${verdict.detail})` : ""}.`;
	}
}

/**
 * Resolve the navigation policy from explicit configuration. Called on the
 * main thread where ToolSession lives; the result is plain serializable data
 * that crosses into the tab worker with every run/message.
 *
 * `configuredEndpointUrls` is the "explicit relay allow" of the port
 * contract: a relay/CDP endpoint host the *user configured themselves*
 * (`browser.relayUrl`, `browser.cdpUrl`, `app.cdp_url`) joins the allowlist,
 * mirroring how hermes exempts its own sidecar from the blocked target set.
 * It is read from settings only — never from page content.
 */
export function resolveNavigationPolicy(input: {
	readonly allowPrivateUrlsSetting?: unknown;
	readonly allowlistSetting?: unknown;
	readonly configuredEndpointUrls?: readonly (string | undefined)[];
	readonly allowFileUrls?: boolean;
	readonly env?: Record<string, string | undefined>;
	readonly lookup?: HostnameResolver;
}): NavigationGuardPolicy {
	const env = input.env ?? process.env;
	const allowPrivateUrls = parseEnvOverride(env.PI_BROWSER_ALLOW_PRIVATE_URLS) ?? truthy(input.allowPrivateUrlsSetting);
	const allowlist = new Set<string>();
	if (Array.isArray(input.allowlistSetting)) {
		for (const entry of input.allowlistSetting) {
			if (typeof entry === "string" && entry.trim()) allowlist.add(entry.trim().toLowerCase());
		}
	}
	for (const endpoint of input.configuredEndpointUrls ?? []) {
		const host = endpointHostname(endpoint);
		if (host) allowlist.add(host);
	}
	return {
		allowPrivateUrls,
		privateUrlAllowlist: [...allowlist],
		allowFileUrls: input.allowFileUrls === true,
		lookup: input.lookup,
	};
}

function parseEnvOverride(value: string | undefined): boolean | undefined {
	const text = value?.trim().toLowerCase();
	if (!text) return undefined;
	if (text === "1" || text === "true" || text === "yes" || text === "on") return true;
	if (text === "0" || text === "false" || text === "no" || text === "off") return false;
	return undefined;
}

function truthy(value: unknown): boolean {
	return value === true || value === "true" || value === 1 || value === "1";
}

function endpointHostname(endpoint: string | undefined): string | undefined {
	const text = endpoint?.trim();
	if (!text) return undefined;
	try {
		return normalizeHostname(new URL(text).hostname);
	} catch {
		return undefined;
	}
}

/**
 * Materialize the serializable cross-boundary settings (`tab-protocol`
 * `NavigationGuardSettings`) into the full guard policy. Main-thread callers
 * (supervisor pre-flight) and worker callers share this conversion; the
 * resolver seam (`lookup`) never crosses the worker boundary.
 */
export function policyFromSettings(
	settings:
		| {
				readonly allowPrivateUrls?: boolean;
				readonly privateUrlAllowlist?: readonly string[];
				readonly allowFileUrls?: boolean;
		  }
		| undefined,
): NavigationGuardPolicy {
	if (!settings) return {};
	return {
		allowPrivateUrls: settings.allowPrivateUrls === true,
		privateUrlAllowlist: settings.privateUrlAllowlist,
		allowFileUrls: settings.allowFileUrls === true,
	};
}
