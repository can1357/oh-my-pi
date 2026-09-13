/**
 * Browser-output secret redaction.
 *
 * Ported from `hermes-agent` (`agent/redact.py`, `tools/browser_tool.py::_redact_browser_output`),
 * Copyright (c) 2025 Nous Research — MIT License. See ./NOTICE for the full attribution
 * and the list of deliberate deltas for the oh-my-pi port.
 *
 * Why this exists: browser-originated values (accessibility snapshots, console/stream
 * text, `display()` payloads, `eval` return values, extracted readable content, page
 * titles) are untrusted page content. A malicious or compromised page can render an
 * API key, bearer token, JWT, database DSN, or a pasted secret into text the model
 * then echoes into the transcript. The tool output is the model boundary, so redaction
 * here is ALWAYS on — there is no opt-out, mirroring hermes' `force=True` at the
 * browser boundary (a user who must see raw values can read the page directly in
 * their own browser instead).
 *
 * The pass order and regex semantics mirror `redact_sensitive_text(force=True)`; see
 * ./NOTICE for the documented deviations:
 *  - the lowercase ENV / config / YAML passes run inside text that also contains URLs
 *    (browser snapshots always do). Instead of hermes' text-level `"://" in text`
 *    gate, matches sitting *inside* a URL token are skipped at match level, so
 *    `?token=...`/path segments pass through while real `password: hunter2` lines are
 *    still masked;
 *  - `user:pass@` URL userinfo is masked unconditionally (parity with the existing
 *    `redactUrlCredentials` seam in tab-worker.ts, which already strips it from the
 *    page URL);
 *  - a `Cookie:` / `Set-Cookie:` header-value pass is added (hermes relies on generic
 *    key passes; the port contract names cookies explicitly);
 *  - E.164 phone-number masking is NOT ported: browser snapshots legitimately carry
 *    `tel:` links and contact numbers, and phone numbers are not credentials;
 *  - web-URL query-parameter values pass through unchanged (hermes parity — magic
 *    links, OAuth callbacks and pre-signed URLs must survive browsing; credential
 *    *shapes* inside them are still caught by the vendor-prefix and JWT passes).
 *
 * Performance: like hermes, every regex pass is gated behind a cheap substring
 * pre-screen. The gates are conservative (a false-positive just runs a regex that
 * cannot match); false negatives are impossible because each regex requires the
 * gated substring.
 */

const DISPLAY_CONTROL_RE = /[\x00-\x1f\x7f\x80-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2064]/;
/** Global twin of `DISPLAY_CONTROL_RE`, hoisted so `maskToken` allocates nothing. */
const DISPLAY_CONTROL_GLOBAL_RE = new RegExp(DISPLAY_CONTROL_RE.source, "g");

/** Mask a secret token: preserve the first 6 and last 4 chars, floor 18 → `"***"`. */
export function maskToken(token: string): string {
	if (!token) return "***";
	// A masked secret must never carry control bytes (newline, tab, DEL, C1,
	// zero-width) into model-facing text — strip before slicing so the length
	// check sees the displayable length (hermes `_DISPLAY_CONTROL_RE` + #55319).
	const cleaned = token.replace(DISPLAY_CONTROL_GLOBAL_RE, "");
	if (!cleaned || cleaned.length < 18) return "***";
	return `${cleaned.slice(0, 6)}...${cleaned.slice(-4)}`;
}

// ── Known vendor prefixes ────────────────────────────────────────────────
// `hermes-agent/agent/redact.py::_PREFIX_PATTERNS` ported verbatim, plus
// `ASIA` (temporary AWS access key id) as an omp addition — same 20-char
// `AKIA` shape class, so "AWS key formats" from the port contract stays true
// for STS credentials too. Each pattern must keep a full literal prefix so
// the substring pre-screen below stays false-negative-free.
const PREFIX_PATTERNS: readonly string[] = [
	"sk-[A-Za-z0-9_-]{10,}", // OpenAI / OpenRouter / Anthropic (sk-ant-*)
	"ghp_[A-Za-z0-9]{10,}", // GitHub PAT (classic)
	"github_pat_[A-Za-z0-9_]{10,}", // GitHub PAT (fine-grained)
	"gho_[A-Za-z0-9]{10,}", // GitHub OAuth access token
	"ghu_[A-Za-z0-9]{10,}", // GitHub user-to-server token
	"ghs_[A-Za-z0-9]{10,}", // GitHub server-to-server token
	"ghr_[A-Za-z0-9]{10,}", // GitHub refresh token
	"xapp-\\d+-[A-Za-z0-9-]{10,}", // Slack app-level token
	"xox[baprs]-[A-Za-z0-9-]{10,}", // Slack bot/app/user tokens
	"AIza[A-Za-z0-9_-]{30,}", // Google API keys
	"pplx-[A-Za-z0-9]{10,}", // Perplexity
	"fal_[A-Za-z0-9_-]{10,}", // Fal.ai
	"fc-[A-Za-z0-9]{10,}", // Firecrawl
	"bb_live_[A-Za-z0-9_-]{10,}", // BrowserBase
	"gAAAA[A-Za-z0-9_=-]{20,}", // Codex encrypted tokens
	"AKIA[A-Z0-9]{16}", // AWS Access Key ID
	"ASIA[A-Z0-9]{16}", // AWS temporary (STS) access key id — omp addition
	"sk_live_[A-Za-z0-9]{10,}", // Stripe secret key (live)
	"sk_test_[A-Za-z0-9]{10,}", // Stripe secret key (test)
	"rk_live_[A-Za-z0-9]{10,}", // Stripe restricted key
	"SG\\.[A-Za-z0-9_-]{10,}", // SendGrid API key
	"hf_[A-Za-z0-9]{10,}", // HuggingFace token
	"r8_[A-Za-z0-9]{10,}", // Replicate API token
	"npm_[A-Za-z0-9]{10,}", // npm access token
	"pypi-[A-Za-z0-9_-]{10,}", // PyPI API token
	"dop_v1_[A-Za-z0-9]{10,}", // DigitalOcean PAT
	"doo_v1_[A-Za-z0-9]{10,}", // DigitalOcean OAuth
	"am_[A-Za-z0-9_-]{10,}", // AgentMail API key
	"sk_[A-Za-z0-9_]{10,}", // ElevenLabs key (underscore form)
	"tvly-[A-Za-z0-9]{10,}", // Tavily
	"exa_[A-Za-z0-9]{10,}", // Exa
	"gsk_[A-Za-z0-9]{10,}", // Groq Cloud
	"syt_[A-Za-z0-9]{10,}", // Matrix access token
	"retaindb_[A-Za-z0-9]{10,}", // RetainDB
	"hsk-[A-Za-z0-9]{10,}", // Hindsight
	"mem0_[A-Za-z0-9]{10,}", // Mem0 Platform
	"brv_[A-Za-z0-9]{10,}", // ByteRover
	"xai-[A-Za-z0-9]{30,}", // xAI (Grok)
	"ntn_[A-Za-z0-9]{10,}", // Notion internal integration token
	"fw-[A-Za-z0-9]{30,}", // Fireworks AI
	"fw_[A-Za-z0-9]{30,}", // Fireworks AI
	"fpk_[A-Za-z0-9]{30,}", // Fireworks AI project key
	"glpat-[A-Za-z0-9_-]{10,}", // GitLab personal access token
	"gloas-[A-Za-z0-9_-]{10,}", // GitLab OAuth application secret
	"gldt-[A-Za-z0-9_-]{10,}", // GitLab deploy token
	"glrt-[A-Za-z0-9_.-]{10,}", // GitLab runner authentication token
	"glrtr-[A-Za-z0-9_.-]{10,}", // GitLab runner registration token
	"glcbt-[A-Za-z0-9_-]{10,}", // GitLab CI/CD job token
	"glptt-[A-Za-z0-9_-]{10,}", // GitLab pipeline trigger token
	"glft-[A-Za-z0-9_-]{10,}", // GitLab feed token
	"glimt-[A-Za-z0-9_-]{10,}", // GitLab incoming mail token
	"glagent-[A-Za-z0-9_-]{10,}", // GitLab agent (KAS) token
	"glsoat-[A-Za-z0-9_-]{10,}", // GitLab service-account access token
	"glffct-[A-Za-z0-9_-]{10,}", // GitLab feature-flags client token
	"glwt-[A-Za-z0-9_-]{10,}", // GitLab workspace token
	"GR1348941[A-Za-z0-9_-]{10,}", // GitLab legacy runner registration token
	"pk-lf-[A-Za-z0-9-]{8,}", // Langfuse public key
];

/** Union of every prefix pattern; boundary-guarded like hermes `_PREFIX_RE`. */
const SECRET_TOKEN_SHAPE_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${PREFIX_PATTERNS.join("|")})(?![A-Za-z0-9_-])`);

/**
 * True when `text` plausibly contains a credential of a known vendor shape.
 * Shared with the navigation guard (url-guard.ts): a URL that embeds a
 * key-shaped token must never be navigated to at all (hermes
 * `evaluate_url_safety`).
 */
export function containsSecretTokenShape(text: string): boolean {
	if (!hasKnownPrefixSubstring(text)) return false;
	return SECRET_TOKEN_SHAPE_RE.test(text);
}

/** Longest literal prefix of a pattern — used for the substring pre-screen. */
function literalPrefix(pattern: string): string {
	const stop = pattern.search(/[[\\(|*+?]/);
	return stop === -1 ? pattern : pattern.slice(0, stop);
}

const PREFIX_SUBSTRINGS: readonly string[] = PREFIX_PATTERNS.map(literalPrefix).filter(s => s.length > 0);

function hasKnownPrefixSubstring(text: string): boolean {
	for (const sub of PREFIX_SUBSTRINGS) if (text.includes(sub)) return true;
	return false;
}

// ── ENV / config / YAML assignment passes ────────────────────────────────

const SECRET_ENV_NAMES = "(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PW|CREDENTIAL|AUTH)";
const ENV_ASSIGN_RE = new RegExp(
	`([A-Z0-9_]{0,50}${SECRET_ENV_NAMES}[A-Z0-9_]{0,50})\\s*=\\s*(['"]?)(\\S+)\\2`,
	"g",
);
// Lowercase env names: only underscore-boundary forms (`openai_key=…`, `db_pw=…`) —
// NOT bare `password=`, which appears in prose, URLs, and form bodies.
const ENV_ASSIGN_LOWER_RE =
	/([a-z0-9_]+(?:_|^)(?:key|pass|pw|token|secret|password|passwd|credential|auth)(?![a-z0-9_]))\s*=\s*(['"]?)(\S+)\2/gi;

const SECRET_CFG_NAMES = "(?:api[ _.\\-]?key|token|secret|passwd|password|credential|auth)";
const CFG_VALUE = "(['\"]?)([^\\s&]+?)\\2(?=[\\s&]|$)";
// Namespaced (dotted) key: the secret word may sit anywhere in a dotted path.
const CFG_DOTTED_RE = new RegExp(
	`([A-Za-z0-9_-]+\\.[A-Za-z0-9_.\\-]*${SECRET_CFG_NAMES}[A-Za-z0-9_.\\-]*|[A-Za-z0-9_.\\-]*${SECRET_CFG_NAMES}[A-Za-z0-9_.\\-]*\\.[A-Za-z0-9_.\\-]+)=${CFG_VALUE}`,
	"gi",
);
// Line-anchored bare key: `password=…` / `export api_key=…` at start of line.
const CFG_ANCHORED_RE = new RegExp(
	`(^[ \\t]*(?:export[ \\t]+)?[A-Za-z0-9_.\\-]*${SECRET_CFG_NAMES}[A-Za-z0-9_.\\-]*)=${CFG_VALUE}`,
	"gim",
);
const CFG_SECRET_WORD_RE = new RegExp(SECRET_CFG_NAMES, "i");

// Programmatic env lookups (`os.getenv(...)`, `process.env.X`, `$ENV{X}`)
// reference variable *names*, not secret values — keep code snippets intact
// (hermes issue #2852).
const ENV_LOOKUP_VALUE_RE = /^(?:os\.(?:getenv|environ)|process\.env|\$ENV\{)/;

// Unquoted YAML / colon config. Bare `auth` is excluded from the key set so
// `Authorization:` / `author:` don't match.
const YAML_CFG_NAMES = "(?:api[ _.\\-]?key|token|secret|passwd|password|credential)";
const YAML_ASSIGN_RE = new RegExp(
	`(^[ \\t]*[A-Za-z0-9_.\\-]*${YAML_CFG_NAMES}[A-Za-z0-9_.\\-]*)(:[ \\t]*)(?!['"])([^\\s&]+)`,
	"gim",
);

// JSON fields: "apiKey": "value", "token": "value", etc.
const JSON_FIELD_RE =
	/("(?:api_?[Kk]ey|token|secret|password|access_token|refresh_token|auth_token|bearer|secret_value|raw_secret|secret_input|key_material)")\s*:\s*"([^"]+)"/g;

const KEY_KEYWORD_RE =
	/(?:api|auth|access|refresh|session|secret)[ _.\\-]?(?:key|token)|token|secret|passwd|password|pass|pw|credential|auth|key/gi;

function isWordStart(s: string, i: number): boolean {
	if (i === 0) return true;
	const prev = s[i - 1] ?? "";
	const cur = s[i] ?? "";
	if (!/[A-Za-z]/.test(prev)) return true;
	if (cur >= "A" && cur <= "Z" && prev >= "a" && prev <= "z") return true; // camelCase: clientSecret
	// Acronym run ending: APIToken — 'T' starts a word when followed by a lowercase
	// char while the preceding run is uppercase.
	if (cur >= "A" && cur <= "Z" && prev >= "A" && prev <= "Z" && i + 1 < s.length && /[a-z]/.test(s[i + 1] ?? ""))
		return true;
	return false;
}

function isWordEnd(s: string, j: number, allowPlural: boolean = true): boolean {
	if (j >= s.length) return true;
	const cur = s[j] ?? "";
	if (!/[A-Za-z]/.test(cur)) return true;
	if (cur >= "A" && cur <= "Z" && /[a-z]/.test(s[j - 1] ?? "")) return true; // secretKey
	if (allowPlural && (cur === "s" || cur === "S")) return isWordEnd(s, j + 1, false);
	return false;
}

/**
 * Word-boundary validator for mixed/lowercase secret keys: rejects prose words
 * that merely embed a keyword (`Secretary:`, `tokenizer:`, `author=`). An
 * ALL-CAPS key still needs an underscore/word boundary to match here — bare
 * `MYTOKEN=` is NOT detected (the `isWordStart` camel/acronym rules don't fire
 * inside an unbroken caps run), which is deliberate: `PROXY`, `MONKEY`, `KEYNOTE`
 * style all-caps names would otherwise mask their own values. Ported from
 * hermes `_key_has_secret_keyword` (nearai/ironclaw#6129 lesson).
 */
export function keyHasSecretKeyword(key: string): boolean {
	for (const m of KEY_KEYWORD_RE[Symbol.matchAll](key)) {
		if (isWordStart(key, m.index) && isWordEnd(key, m.index + m[0].length)) return true;
	}
	return false;
}

/**
 * True when position `start` sits inside a URL token (a `://` appears earlier
 * in the same whitespace-free run). omp delta replacing hermes' text-level
 * `"://" not in text` gate, which would disable the assignment passes for
 * every browser snapshot (pages always contain URLs). Query/fragment params
 * and path segments must keep passing through (hermes parity); only the
 * *inside-a-URL* position is skipped, match by match.
 */
function insideUrlToken(text: string, start: number): boolean {
	for (let i = start - 1; i >= 0; i--) {
		const c = text[i];
		if (c === undefined) break;
		if (/\s/.test(c) || c === "'" || c === '"' || c === ">" || c === "]") break;
		if (c === "/" && i > 0 && text[i - 1] === "/" && i > 1 && text[i - 2] === ":") return true;
	}
	return false;
}

// Authorization headers — any scheme (Bearer, Basic, Token, Digest, …) plus
// the bare-credential form, and Proxy-Authorization. Header name + scheme
// word are preserved for debuggability; the quote-excluding credential class
// keeps `"Authorization: Bearer …"` in JSON strings syntactically intact
// (hermes #43083).
const AUTH_HEADER_RE = /((?:Proxy-)?Authorization:\s*)([A-Za-z][\w.+-]*\s+)?([^\s"']+)/gi;
// API-key style auth headers carrying a single opaque value (no scheme word).
const SECRET_HEADER_RE =
	/((?:x-api-key|x-goog-api-key|api-key|apikey|x-api-token|x-auth-token|x-access-token)\s*:\s*)(\S+)/gi;
// omp extension (the port contract names cookies explicitly; hermes has no cookie pass).
const COOKIE_HEADER_RE = /((?:Set-Cookie|Cookie):\s*)([^\r\n"']+)/gi;
// Credential-bearing JSON *fields*: the `document.cookie` / request-header dumps
// an aria snapshot or `JSON.stringify(getAllResponseHeaders())` produces carry
// these quoted keys, which JSON_FIELD_RE's name list does not include.
const JSON_CRED_FIELD_RE =
	/("(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|credential)")\s*:\s*"([^"]+)"/gi;
// Bare cookie-jar bodies (`sid=…; csrf_token=…`) with no `Cookie:` header name in
// sight — what `document.cookie` and pasted request dumps look like. Value class
// excludes dots so an IP/path-shaped run is not mistaken for a cookie value.
const COOKIE_JAR_RE = /([A-Za-z][A-Za-z0-9_.-]*)=([A-Za-z0-9+/=_-]{8,})(?![A-Za-z0-9+/=_-])/g;
const TELEGRAM_RE = /(?:(bot)?(\d{8,}):)([-A-Za-z0-9_]{30,})/g;
const PRIVATE_KEY_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;
const DB_CONNSTR_RE = /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:)([^@\s]+)(@)/gi;
// Bare-token userinfo `scheme://TOKEN@host` — never a round-trip workflow
// token position (those live in the query string), so masking is safe
// (hermes #6396).
const URL_BARE_TOKEN_RE = /((?:https?|wss?|git|ssh|ftp|ftps|sftp):\/\/)([^\s:@/]{8,})(@[^\s]+)/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_=-]{4,}){0,2}/g;
// `user:pass@` / bare-`token@` userinfo in any URL reference (network-path
// `//user:pass@host` included). omp: unconditional — `redactUrlCredentials`
// already strips userinfo from the page URL itself, so pages that survive
// that seam should not smuggle the same credential through body text.
const URL_USERINFO_RE = /(\/\/)([^/\s?#@]+)@/g;

const FORM_BODY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*=[^&\s]*(?:&[A-Za-z_][A-Za-z0-9_.-]*=[^&\s]*)+$/;
// Sensitive form-body key names (exact match after percent-decode + casefold;
// hermes `_SENSITIVE_QUERY_PARAMS` ∩ `_SENSITIVE_BODY_KEYS`, form-body pass).
const SENSITIVE_FORM_KEYS: Record<string, true> = {
	access_token: true,
	refresh_token: true,
	id_token: true,
	token: true,
	api_key: true,
	apikey: true,
	client_secret: true,
	password: true,
	auth: true,
	jwt: true,
	secret: true,
	key: true,
	code: true,
	signature: true,
	"x-amz-signature": true,
};

// Control / zero-width characters that can split a token body so
// SECRET_TOKEN_SHAPE_RE cannot match across them (`sk-abc\x1bdef…`).
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/g;
/** Non-global twin for the single-character membership tests below. */
const CONTROL_CHAR_RE = new RegExp(CONTROL_CHARS_RE.source);
/** Global twin of the vendor-shape matcher, hoisted out of the per-call path. */
const SECRET_TOKEN_SHAPE_GLOBAL_RE = new RegExp(SECRET_TOKEN_SHAPE_RE.source, "g");
const TOKEN_BODY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.";

/** True when `text` holds any control/zero-width byte. */
function hasControlChar(text: string): boolean {
	return CONTROL_CHAR_RE.test(text);
}

/**
 * Mask tokens whose body is split by control/zero-width characters (hermes
 * `_mask_control_split_tokens`, issue #77484). Match on a control-stripped
 * copy, then mask the corresponding span in the original — but only when the
 * original span contains nothing but token-body and control chars and does
 * not run into a `=` (a `KEY=` name means the match crossed unrelated text).
 */
function maskControlSplitTokens(text: string): string {
	const stripped = text.replace(CONTROL_CHARS_RE, "");
	if (stripped === text) return text;
	const origIdx: number[] = [];
	for (let i = 0; i < text.length; i++) {
		if (!hasControlChar(text[i] ?? "")) origIdx.push(i);
	}
	const spans: Array<[start: number, end: number, replacement: string]> = [];
	SECRET_TOKEN_SHAPE_GLOBAL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = SECRET_TOKEN_SHAPE_GLOBAL_RE.exec(stripped)) !== null) {
		const body = m[0];
		const startOrig = origIdx[m.index] ?? 0;
		const endOrig = (origIdx[m.index + body.length - 1] ?? 0) + 1;
		const span = text.slice(startOrig, endOrig);
		// A complete token at end-of-line followed by unrelated next-line text
		// keeps its line structure (hermes' newline guard).
		if ((span.includes("\n") || span.includes("\r")) && SECRET_TOKEN_SHAPE_RE.test(span)) continue;
		let ok = true;
		for (const c of span) {
			if (TOKEN_BODY_CHARS.includes(c)) continue;
			if (hasControlChar(c)) continue;
			ok = false;
			break;
		}
		if (!ok) continue;
		if (endOrig < text.length && text[endOrig] === "=") continue;
		spans.push([startOrig, endOrig, maskToken(body)]);
	}
	if (!spans.length) return text;
	let out = "";
	let cursor = 0;
	for (const [start, end, replacement] of spans) {
		if (start < cursor) continue;
		out += text.slice(cursor, start) + replacement;
		cursor = end;
	}
	return out + text.slice(cursor);
}

function redactEnvAssignment(name: string, quote: string, value: string, start: number, text: string): string {
	if (ENV_LOOKUP_VALUE_RE.test(value)) return `${name}=${quote}${value}${quote}`;
	if (insideUrlToken(text, start)) return `${name}=${quote}${value}${quote}`;
	if (!keyHasSecretKeyword(name)) return `${name}=${quote}${value}${quote}`;
	return `${name}=${quote}${maskToken(value)}${quote}`;
}

/** Redact sensitive values in a pure form-urlencoded body (`k=v&k=v`). */
function redactFormBody(text: string): string {
	const trimmed = text.trim();
	if (trimmed.includes("\n") || !FORM_BODY_RE.test(trimmed)) return text;
	return trimmed
		.split("&")
		.map(pair => {
			const eq = pair.indexOf("=");
			if (eq === -1) return pair;
			const key = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			let decoded = key;
			try {
				decoded = decodeURIComponent(key);
			} catch {
				// keep raw key
			}
			return SENSITIVE_FORM_KEYS[decoded.toLowerCase()] === true ? `${key}=***` : pair;
		})
		.join("&");
}

/**
 * Apply every redaction pass to one string. Safe on any text — non-matching
 * content passes through byte-for-byte unchanged. Always on; there is no
 * opt-out on the browser egress path.
 */
export function redactBrowserText(text: string): string {
	if (!text) return text;

	// 1. Known vendor prefixes (sk-, ghp_, …) incl. control-split smuggling.
	//    The substring pre-screen is also run on a control-stripped copy: a
	//    zero-width byte inside the literal prefix itself (`sk\u200b-…`) would
	//    otherwise skip the pass that exists precisely to catch that trick.
	const controlStripped = hasControlChar(text) ? text.replace(CONTROL_CHARS_RE, "") : "";
	if (hasKnownPrefixSubstring(text) || (controlStripped !== "" && hasKnownPrefixSubstring(controlStripped))) {
		text = maskControlSplitTokens(text);
		text = text.replace(SECRET_TOKEN_SHAPE_GLOBAL_RE, m => maskToken(m));
	}

	if (text.includes("=")) {
		// 2. ENV assignments: OPENAI_API_KEY=*** (uppercase embedded names,
		//    underscore-boundary lowercase names, dotted + line-anchored config keys).
		text = text.replace(
			ENV_ASSIGN_RE,
			(match, name: string, quote: string, value: string, offset: number, whole: string) =>
				redactEnvAssignment(name, quote, value, offset, whole),
		);
		text = text.replace(
			ENV_ASSIGN_LOWER_RE,
			(match, name: string, quote: string, value: string, offset: number, whole: string) =>
				redactEnvAssignment(name, quote, value, offset, whole),
		);
		if (CFG_SECRET_WORD_RE.test(text)) {
			text = text.replace(
				CFG_DOTTED_RE,
				(match, name: string, quote: string, value: string, offset: number, whole: string) =>
					redactEnvAssignment(name, quote ?? "", value, offset, whole),
			);
			text = text.replace(
				CFG_ANCHORED_RE,
				(match, name: string, quote: string, value: string, offset: number, whole: string) =>
					redactEnvAssignment(name, quote ?? "", value, offset, whole),
			);
		}
	}

	// 3. JSON fields: "apiKey": "value" (quoted values; the YAML pass skips
	//    them via its lookahead, so order matters), plus the credential-bearing
	//    header/cookie field names a snapshot or header dump produces.
	if (text.includes(":") && text.includes('"')) {
		text = text.replace(JSON_FIELD_RE, (_match, key: string, value: string) =>
			ENV_LOOKUP_VALUE_RE.test(value) ? `${key}: "${value}"` : `${key}: "${maskToken(value)}"`,
		);
		text = text.replace(JSON_CRED_FIELD_RE, (_match, key: string, value: string) =>
			ENV_LOOKUP_VALUE_RE.test(value) ? `${key}: "${value}"` : `${key}: "${maskToken(value)}"`,
		);
	}

	// 4. Unquoted YAML / colon config: `password: hunter2`.
	if (text.includes(":") && CFG_SECRET_WORD_RE.test(text)) {
		text = text.replace(
			YAML_ASSIGN_RE,
			(match, key: string, sep: string, value: string, offset: number, whole: string) => {
				if (ENV_LOOKUP_VALUE_RE.test(value)) return match;
				if (insideUrlToken(whole, offset)) return match;
				if (!keyHasSecretKeyword(key)) return match;
				return `${key}${sep}${maskToken(value)}`;
			},
		);
	}

	// 5. Authorization headers (any scheme, bare-credential form, Proxy-*).
	if (text.toLowerCase().includes("authorization")) {
		text = text.replace(
			AUTH_HEADER_RE,
			(_m, head: string, scheme: string | undefined, cred: string) => `${head}${scheme ?? ""}${maskToken(cred)}`,
		);
	}

	// 6. Single-value API-key headers (x-api-key, api-key, …).
	if (text.includes(":")) {
		text = text.replace(SECRET_HEADER_RE, (_m, head: string, value: string) => `${head}${maskToken(value)}`);
	}

	// 7. Cookie headers (omp extension).
	if (text.toLowerCase().includes("cookie")) {
		text = text.replace(COOKIE_HEADER_RE, (_m, head: string, value: string) => `${head}${maskToken(value)}`);
	}

	// 8. Telegram bot tokens.
	if (text.includes(":")) {
		text = text.replace(TELEGRAM_RE, (_m, bot: string | undefined, digits: string) => `${bot ?? ""}${digits}:***`);
	}

	// 8b. Cookie-jar bodies without a `Cookie:` header name in sight
	//     (`document.cookie`, pasted request dumps). URL query params are
	//     skipped — hermes parity keeps magic links and OAuth callbacks
	//     round-trippable; this pass only fires on `; `/`,`-separated pairs.
	if (text.includes("=") && (text.includes("; ") || text.includes(","))) {
		COOKIE_JAR_RE.lastIndex = 0;
		text = text.replace(COOKIE_JAR_RE, (match, name: string, value: string, offset: number) =>
			insideUrlToken(text, offset) ? match : `${name}=${maskToken(value)}`,
		);
	}

	// 9. Private key blocks.
	if (text.includes("BEGIN") && text.includes("-----")) {
		text = text.replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]");
	}

	if (text.includes("//")) {
		// 10. Database connection-string passwords.
		text = text.replace(DB_CONNSTR_RE, (_m, head: string, _pw: string, at: string) => `${head}***${at}`);
		// 11. Bare-token userinfo: scheme://TOKEN@host.
		text = text.replace(
			URL_BARE_TOKEN_RE,
			(_m, head: string, token: string, tail: string) => `${head}${maskToken(token)}${tail}`,
		);
		// 12. `user:pass@` userinfo — unconditional (omp delta; see header).
		text = text.replace(URL_USERINFO_RE, (_m, slashes: string, userinfo: string) => {
			const colon = userinfo.indexOf(":");
			return colon === -1 ? `${slashes}***@` : `${slashes}${userinfo.slice(0, colon)}:***@`;
		});
	}

	// 13. JWTs (header starts with "eyJ" = base64 for "{").
	if (text.includes("eyJ")) {
		text = text.replace(JWT_RE, m => maskToken(m));
	}

	// 14. Form-urlencoded bodies (only triggers on clean k=v&k=v inputs).
	if (text.includes("&") && text.includes("=")) {
		text = redactFormBody(text);
	}

	return text;
}

/**
 * Recursively redact every string inside a browser-originated value (hermes
 * `_redact_browser_output`): observation objects, aria snapshots, extract
 * payloads, eval return values, display() JSON. Arrays and plain objects are
 * walked; everything else (numbers, booleans, binary payloads, class
 * instances) passes through untouched so image data and structured-clone
 * shapes survive.
 *
 * `seen` maps an already-walked object to THE copy produced for it, so an
 * aliased value (`{ a, b: a }`) collapses to one redacted object instead of
 * leaking the raw second reference — and a cycle terminates against the copy
 * rather than the original.
 */
export function redactBrowserOutput(value: unknown, seen: Map<object, unknown> = new Map()): unknown {
	if (typeof value === "string") return redactBrowserText(value);
	if (Array.isArray(value)) {
		return value.map(item => redactBrowserOutput(item, seen));
	}
	if (value !== null && typeof value === "object") {
		const memo = seen.get(value);
		if (seen.has(value)) return memo;
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			// Not a plain object (Page, ElementHandle, Date, RegExp, typed
			// array, …): copying it would corrupt it; leave it to cloneSafe.
			return value;
		}
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		// Register before recursing so cycles/aliases resolve to this copy.
		seen.set(value, out);
		for (const key of Object.keys(source)) {
			const redacted = redactBrowserOutput(source[key], seen);
			const original = source[key];
			// A secret-bearing key name is itself the context that makes a raw
			// value a credential (`{ api_key: "…" }` carries no `api_key=` text
			// for the assignment passes). Mask it only when the text passes left
			// the string untouched — an already-masked value must not be masked
			// again (that would collapse `ghp_AB...1234` to `***`), and a value
			// that is an env-lookup expression stays intact.
			if (
				typeof redacted === "string" &&
				redacted === original &&
				keyHasSecretKeyword(key.replace(/^["']|["']$/g, "")) &&
				!ENV_LOOKUP_VALUE_RE.test(redacted)
			) {
				out[key] = maskToken(redacted);
			} else {
				out[key] = redacted;
			}
		}
		return out;
	}
	return value;
}
