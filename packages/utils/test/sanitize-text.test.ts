import { describe, expect, it } from "bun:test";
import { redactSecrets, redactUrlSecrets, sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";

describe("sanitizeText", () => {
	it("strips ANSI CSI and removes C0/C1 control chars while keeping tab + LF", () => {
		const input = "\x1b[31mred\x1b[0m\ra\u0000b\tline\ncarriage\r\u0001\u0085";
		expect(sanitizeText(input)).toBe("redab\tline\ncarriage");
	});

	it("drops lone surrogates and preserves valid surrogate pairs", () => {
		expect(sanitizeText(`a\ud800b\udc00c`)).toBe("abc");
		const validPair = "a\u{1f600}b";
		expect(sanitizeText(validPair)).toBe(validPair);
	});

	it("drops replacement characters on malformed input", () => {
		expect(sanitizeText("a\ud800�b")).toBe("ab");
	});

	it("preserves replacement characters on well-formed input", () => {
		expect(sanitizeText("a�b")).toBe("a�b");
	});

	it("preserves valid surrogate pairs while stripping controls", () => {
		const validPair = "\u{1f600}";
		expect(sanitizeText(`a${validPair}\u0000b`)).toBe(`a${validPair}b`);
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(sanitizeText("\x1b]0;title\x07hello")).toBe("hello");
	});

	it("strips OSC sequences terminated by ST (ESC \\)", () => {
		expect(sanitizeText("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\!")).toBe("link!");
	});

	it("returns the original string instance when no changes are needed", () => {
		const clean = "plain ascii\twith\ttabs\nand newlines";
		expect(sanitizeText(clean)).toBe(clean);
	});

	it("strips DCS sequences terminated by ST", () => {
		expect(sanitizeText("before\x1bPpayload\x1b\\after")).toBe("beforeafter");
	});

	it("handles single-byte ESC finals (e.g. ESC c reset)", () => {
		expect(sanitizeText("a\x1bcb")).toBe("ab");
	});

	it("strips DEL and normalizes lone CR", () => {
		expect(sanitizeText("a\x7fb\rc")).toBe("abc");
	});
});

describe("redactUrlSecrets", () => {
	it("redacts credential-bearing query params but keeps the rest verbatim", () => {
		expect(redactUrlSecrets("https://mcp.exa.ai/mcp?exaApiKey=sk-secret-123&foo=bar%20baz#frag")).toBe(
			"https://mcp.exa.ai/mcp?exaApiKey=[redacted]&foo=bar%20baz#frag",
		);
		expect(redactUrlSecrets("https://mcp.exa.ai/mcp")).toBe("https://mcp.exa.ai/mcp");
	});

	it("redacts inside identifiers that embed a URL, and leaves text without one alone", () => {
		expect(redactUrlSecrets("mcp_oauth:profile:default:https://host/mcp?ref=1&token=zzz")).toBe(
			"mcp_oauth:profile:default:https://host/mcp?ref=1&token=[redacted]",
		);
		expect(redactUrlSecrets("anthropic")).toBe("anthropic");
	});

	it("classifies auth-prefixed, password, credential, signature, and bare key parameters as secrets", () => {
		expect(
			redactUrlSecrets(
				"https://h/mcp?authCode=a&oauth_code=o&password=p&credential=c&signature=s&key=k&project_ref=keep",
			),
		).toBe(
			"https://h/mcp?authCode=[redacted]&oauth_code=[redacted]&password=[redacted]&credential=[redacted]&signature=[redacted]&key=[redacted]&project_ref=keep",
		);
	});

	it("classifies a percent-encoded parameter name as the receiving parser decodes it, keeping the spelling", () => {
		expect(redactUrlSecrets("https://h/mcp?api%4Bey=secret&to%6ben=secret&ref%3Fx=keep&bad%ZZ=keep")).toBe(
			"https://h/mcp?api%4Bey=[redacted]&to%6ben=[redacted]&ref%3Fx=keep&bad%ZZ=keep",
		);
	});

	it("redacts userinfo and fragment parameters", () => {
		expect(redactUrlSecrets("https://user:hunter2@host/mcp#access_token=abc&state=keep")).toBe(
			"https://[redacted]@host/mcp#access_token=[redacted]&state=keep",
		);
	});

	it("keeps safe prose around URLs without treating ambiguous punctuation as safe", () => {
		expect(redactUrlSecrets("request to https://host/token?flow=refresh returned invalid_grant")).toBe(
			"request to https://host/token?flow=refresh returned invalid_grant",
		);
		const output = redactUrlSecrets("see https://host/x?apiKey=abc! then retry.");
		expect(output.startsWith("see https://host/x?apiKey=")).toBe(true);
		expect(output.endsWith(" then retry.")).toBe(true);
		expect(output).not.toContain("abc");
		expect(output).not.toContain("!");
	});

	it("removes complete punctuation-only and punctuation-suffixed secret values", () => {
		const url = "https://host/mcp?token=!!!&apiKey=abc!#password=.,;:!?)";
		const redacted = new URL(redactUrlSecrets(url));
		expect(redacted.searchParams.get("token")).toBe("[redacted]");
		expect(redacted.searchParams.get("apiKey")).toBe("[redacted]");
		expect(new URLSearchParams(redacted.hash.slice(1)).get("password")).toBe("[redacted]");
		expect(redactSecrets("request https://host/mcp?token=!!! failed")).toBe(
			"request https://host/mcp?token=[redacted] failed",
		);
	});

	it.each([
		["space", "https://host/mcp?ref=hello world&apiKey=native-secret"],
		["tab", "https://host/mcp?ref=hello\tworld&api\tKey=native-secret"],
		["quote", 'https://host/mcp?ref=hello"world&apiKey=native-secret'],
	])("uses the receiving URL parser for a literal %s before a credential", (_boundary, input) => {
		const received = new URL(input);
		expect(received.searchParams.get("apiKey")).toBe("native-secret");
		for (const prefix of ["", "mcp_oauth:profile:default:"]) {
			const output = redactUrlSecrets(prefix + input);
			expect(output.startsWith(prefix)).toBe(true);
			const redacted = new URL(output.slice(prefix.length));
			expect(redacted.searchParams.get("apiKey")).toBe("[redacted]");
			expect(redacted.searchParams.get("ref")).toBe(received.searchParams.get("ref"));
			expect(output).not.toContain("native-secret");
		}
	});
});

describe("redactSecrets", () => {
	it("redacts entire authorization fields regardless of scheme", () => {
		for (const scheme of ["Token", "Digest", "ApiKey", "Custom-Scheme", "Bearer", "Basic"]) {
			const output = redactSecrets(`Authorization: ${scheme} abc123; status=keep`);
			expect(output).not.toContain("abc123");
			expect(output).not.toContain(scheme);
		}
	});

	it("redacts complete native authorization values and preserves structured neighbors", () => {
		for (const value of ['Token prefix;TAIL_SECRET, "quoted tail"', "ApiKey prefix}TAIL_SECRET unquoted tail"]) {
			const headers = new Headers({ Authorization: value });
			expect(headers.get("Authorization")).toBe(value);
			const diagnostic = redactSecrets(`Authorization: ${headers.get("Authorization")}\nstatus=keep`);
			expect(diagnostic).not.toContain("prefix");
			expect(diagnostic).not.toContain("TAIL_SECRET");
			expect(diagnostic).not.toContain("tail");
			expect(diagnostic).toContain("\nstatus=keep");
			expect(JSON.parse(redactSecrets(JSON.stringify({ Authorization: value, status: "keep" })))).toEqual({
				Authorization: "[redacted]",
				status: "keep",
			});
		}
	});

	it("redacts parsed authorization values with escaped names and quotes as whole fields", () => {
		const input = String.raw`{"Authoriz\u0061tion":"Custom-Scheme first \"second, third\"","status":"keep"}`;
		expect(JSON.parse(redactSecrets(input))).toEqual({ Authorization: "[redacted]", status: "keep" });
		const encoded = JSON.stringify(input);
		expect(JSON.parse(JSON.parse(redactSecrets(encoded)))).toEqual({ Authorization: "[redacted]", status: "keep" });
	});

	it("withholds unterminated authorization quotes and their escaped tails", () => {
		for (const prefix of ['Token "', "Basic '", String.raw`Digest \"`]) {
			expect(redactSecrets("Authorization: " + prefix + "truncated-secret\\")).toBe("Authorization: [redacted]");
		}
	});

	it("redacts compound key labels separated by whitespace", () => {
		for (const label of ["Invalid API key", "private key", "access\tkey", "auth code"]) {
			const output = redactSecrets(`${label}: opaque-secret`);
			expect(output).not.toContain("opaque-secret");
		}
	});
	it("keeps bearer-named structured credentials redacted", () => {
		expect(
			JSON.parse(redactSecrets(JSON.stringify({ bearer: "opaque-one", bearerValue: "opaque-two", status: "keep" }))),
		).toEqual({ bearer: "[redacted]", bearerValue: "[redacted]", status: "keep" });
	});

	it("normalizes terminal styling before classifying JSON and credential names", () => {
		expect(redactSecrets("oauth refresh failed: grant\trevoked\x1b[31m!")).toBe(
			"oauth refresh failed: grant\trevoked!",
		);
		expect(
			redactSecrets("client_\x1b[31msecret\x1b[0m=styled-secret; https://host/mcp?token=url-secret&ref=keep"),
		).toBe("client_secret=[redacted]; https://host/mcp?token=[redacted]&ref=keep");
	});

	it("walks embedded JSON using decoded names and replaces whole secret subtrees", () => {
		const body =
			'{"key":"bare-key-secret","oauth_code":"oauth-secret","tokenValue":123456,"client_\\u0073ecret":{"value":"nested-secret","list":["array-secret"]},"items":[{"refresh_token":"child-secret","status":"keep"}],"error":"invalid_grant"}';
		const output = redactSecrets("HTTP 400 " + body + "; retry denied");
		expect(output.startsWith("HTTP 400 ")).toBe(true);
		expect(output.endsWith("; retry denied")).toBe(true);
		expect(JSON.parse(output.slice(9, -14))).toEqual({
			key: "[redacted]",
			oauth_code: "[redacted]",
			tokenValue: "[redacted]",
			client_secret: "[redacted]",
			items: [{ refresh_token: "[redacted]", status: "keep" }],
			error: "invalid_grant",
		});
	});

	it("redacts decoded JSON strings without corrupting escapes or quoted braces", () => {
		const input = JSON.stringify({
			error_description: "client_secret=\"alpha beta\" rejected; Authorization: Basic 'gamma delta'",
			detail: 'server said "} still inside the string"',
			nested: JSON.stringify({ oauth_code: "nested-encoded-secret", status: "keep" }),
		});
		expect(JSON.parse(redactSecrets(input))).toEqual({
			error_description: 'client_secret="[redacted]" rejected; Authorization: [redacted]',
			detail: 'server said "} still inside the string"',
			nested: JSON.stringify({ oauth_code: "[redacted]", status: "keep" }),
		});
		const encoded = JSON.stringify(JSON.stringify({ key: "encoded-secret", status: "keep" }));
		const encodedOutput = redactSecrets("HTTP 400 " + encoded);
		expect(encodedOutput).not.toContain("encoded-secret");
		expect(JSON.parse(JSON.parse(encodedOutput.slice(9)))).toEqual({ key: "[redacted]", status: "keep" });
	});

	it("does not retain overwritten duplicate JSON fields containing secrets", () => {
		const output = redactSecrets('{"detail":"client_secret=overwritten-secret","detail":"safe"}');
		expect(output).not.toContain("overwritten-secret");
		expect(JSON.parse(output)).toEqual({ detail: "safe" });
	});

	it("consumes mixed quoted assignment values", () => {
		expect(redactSecrets("client_secret=abc'def")).toBe("client_secret=[redacted]");
		expect(redactSecrets('client_secret=abc"def ghi"; status=keep')).toBe("client_secret=[redacted]; status=keep");
		expect(redactSecrets('client_secret={"value": "nested prose secret"}; status=keep')).toBe(
			"client_secret=[redacted]; status=keep",
		);
	});

	it("consumes escaped quote delimiters and unterminated values with dangling escapes", () => {
		const escaped = 'client_secret=\\"alpha beta\\"; status=keep';
		expect(redactSecrets(escaped)).toBe('client_secret=\\"[redacted]\\"; status=keep');
		for (const prefix of ['client_secret="', "client_secret='"]) {
			expect(redactSecrets(prefix + "truncated-secret\\")).toBe(prefix + "[redacted]" + prefix.at(-1));
		}
	});

	it("withholds malformed JSON rather than exposing nested or escaped tails", () => {
		for (const body of [
			'{"client_secret":{"value":"nested-secret"},"status":"keep",}',
			'{"client_\\u0073ecret":"escaped-secret"',
			'{"error_description":"client_secret=\\"truncated-secret\\',
		]) {
			expect(redactSecrets("HTTP 400 " + body)).toBe("HTTP 400 [redacted]");
		}
	});

	it("preserves safe URL neighbors in prose and JSON rather than treating them as secret assignment tails", () => {
		const url = "https://host/mcp?token=url-secret&ref=keep%20this#password=fragment-secret&mode=keep";
		const safeUrl = "https://host/mcp?token=[redacted]&ref=keep%20this#password=[redacted]&mode=keep";
		expect(redactSecrets("request {" + url + "} failed; client_secret=body-secret")).toBe(
			"request {" + safeUrl + "} failed; client_secret=[redacted]",
		);
		expect(JSON.parse(redactSecrets(JSON.stringify({ url, status: "keep" })))).toEqual({
			url: safeUrl,
			status: "keep",
		});
	});

	it("consumes quoted secrets and punctuation-bearing unquoted values", () => {
		for (const value of ['"abc def"', "'abc,def'", '"abc;def"', "abc,def", '"abc def', "'abc,def"]) {
			const result = redactSecrets("client_secret=" + value);
			expect(result).not.toContain("abc");
			expect(result).not.toContain("def");
		}
	});
	it("redacts a token endpoint body that echoes the submitted refresh token and client secret", () => {
		const cause =
			'oauth refresh failed: HTTP 400 {"error":"invalid_grant","error_description":"grant revoked","refresh_token":"rt-echoed-1234","client_secret":"cs-echoed"}';
		const redacted = redactSecrets(cause);
		expect(redacted).not.toContain("rt-echoed-1234");
		expect(redacted).not.toContain("cs-echoed");
		expect(redacted).toContain('"error":"invalid_grant"');
		expect(redacted).toContain('"error_description":"grant revoked"');
	});

	it("redacts name=value pairs and JWTs in free text", () => {
		expect(redactSecrets("client_secret=s3cr3t; password: hunter2; authCode=q")).toBe(
			"client_secret=[redacted]; password: [redacted]; authCode=[redacted]",
		);
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
		expect(redactSecrets(`token ${jwt} expired`)).toBe("token [redacted] expired");
		expect(redactSecrets("not a url?apiKey=zzz")).toBe("not a url?apiKey=[redacted]");
	});

	it("keeps prose whose names merely contain a secret word", () => {
		expect(redactSecrets("OAuthError: invalid_grant; refresh token expired; tokens: 500; authorized: yes")).toBe(
			"OAuthError: invalid_grant; refresh token expired; tokens: 500; authorized: yes",
		);
	});
});
