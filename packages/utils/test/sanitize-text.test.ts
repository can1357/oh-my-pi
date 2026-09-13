import { describe, expect, it } from "bun:test";
import { redactUrlSecrets, sanitizeText } from "@oh-my-pi/pi-utils/sanitize-text";

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
		expect(redactUrlSecrets("https://mcp.exa.ai/mcp?exaApiKey=sk-secret-123&foo=bar#frag")).toBe(
			"https://mcp.exa.ai/mcp?exaApiKey=[redacted]&foo=bar#frag",
		);
		expect(redactUrlSecrets("https://mcp.exa.ai/mcp")).toBe("https://mcp.exa.ai/mcp");
	});

	it("redacts inside identifiers that embed a URL, which the URL parser rejects", () => {
		expect(redactUrlSecrets("mcp_oauth:profile:default:https://host/mcp?ref=1&token=zzz")).toBe(
			"mcp_oauth:profile:default:https://host/mcp?ref=1&token=[redacted]",
		);
		expect(redactUrlSecrets("not a url?apiKey=zzz")).toBe("not a url?apiKey=[redacted]");
	});
});
