/**
 * Browser-output redaction pass: ported from hermes-agent
 * (`agent/redact.py`), MIT, Copyright (c) 2025 Nous Research.
 * See src/tools/browser/NOTICE.
 */
import { describe, expect, it } from "bun:test";
import {
	containsSecretTokenShape,
	keyHasSecretKeyword,
	redactBrowserOutput,
	redactBrowserText,
} from "../../src/tools/browser/output-redact";

describe("browser-output redaction: secret shapes", () => {
	it("masks API key env assignments (sk-…)", () => {
		expect(redactBrowserText("key: OPENAI_API_KEY=sk-proj-abcdef1234567890ZZZZ more")).toBe(
			"key: OPENAI_API_KEY=*** more",
		);
	});

	it("masks GitHub PATs, bearer tokens and API-key headers", () => {
		expect(redactBrowserText("console log says ghp_ABCDEFGHIJKLMNOPQRST1234 done")).toBe(
			"console log says ghp_AB...1234 done",
		);
		expect(redactBrowserText("Authorization: Bearer sk-reallylongtoken-abcdefghij")).toBe(
			"Authorization: Bearer ***",
		);
		expect(redactBrowserText("x-api-key: abcdefghijklmnopqrstuvwxyz")).toBe("x-api-key: ***");
	});

	it("masks cookies and password fields / form params", () => {
		expect(redactBrowserText("Cookie: sessionid=abc123def456ghi789jkl")).toBe("Cookie: sessio...9jkl");
		expect(redactBrowserText("password: Sup3rS3cretValueHere!")).toBe("password: Sup3rS...ere!");
		expect(redactBrowserText("username=alice&password=CorrectHorseBatteryStaple1&csrf=xyz")).toBe(
			"username=alice&password=***&csrf=xyz",
		);
	});

	it("masks JWTs and PEM private-key blocks", () => {
		expect(
			redactBrowserText("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNpyP"),
		).toBe("eyJhbG...NpyP");
		expect(redactBrowserText("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----")).toBe(
			"[REDACTED PRIVATE KEY]",
		);
	});

	it("masks embedded JSON apiKey values", () => {
		expect(redactBrowserText('{"apiKey": "sk-test-abcdef123456"}')).toBe('{"apiKey": "***"}');
	});

	it("masks userinfo in URLs", () => {
		expect(redactBrowserText("https://user:hunter2passw0rd99@api.example.com/v1")).toBe(
			"https://user:***@api.example.com/v1",
		);
		expect(redactBrowserText("postgresql://app:SuperSecretDbPass@db.internal:5432/prod")).toBe(
			"postgresql://app:***@db.internal:5432/prod",
		);
	});

	it("leaves non-secret text and public URLs untouched", () => {
		expect(redactBrowserText('- heading "Status"')).toBe('- heading "Status"');
		expect(redactBrowserText("https://example.com/cb?code=ABC123&state=xyz")).toBe(
			"https://example.com/cb?code=ABC123&state=xyz",
		);
		expect(redactBrowserText("Secretary: J.Smith")).toBe("Secretary: J.Smith");
	});
});

describe("browser-output redaction: keyword + shape gates", () => {
	it("flags secret-bearing keys but not lookalike words", () => {
		expect(keyHasSecretKeyword("Secretary")).toBe(false);
		expect(keyHasSecretKeyword("clientSecret")).toBe(true);
		expect(keyHasSecretKeyword("MYTOKEN")).toBe(false);
		expect(keyHasSecretKeyword("KEYBOARD")).toBe(false);
	});

	it("detects secret-token shapes inside URLs", () => {
		expect(containsSecretTokenShape("https://x.dev/?k=sk-proj-abcdef1234567890")).toBe(true);
	});
});

describe("browser-output redaction: recursive + integration", () => {
	it("recurses through objects/arrays but preserves non-strings", () => {
		const result = redactBrowserOutput({
			a: ["ghp_ABCDEFGHIJKLMNOPQRST1234", 5],
			b: { c: null },
			d: new Date(0),
		}) as { a: unknown[]; b: { c: null }; d: Date };
		expect(result.a[0]).toBe("ghp_AB...1234");
		expect(result.a[1]).toBe(5);
		expect(result.b).toEqual({ c: null });
		expect(result.d).toBeInstanceOf(Date);
	});

	it("masks a nested secret inside an ARIA-snapshot-shaped object", () => {
		// Mirrors the observe() snapshot reaching the model (contract item 2).
		const snapshot = {
			url: "https://example.com/",
			title: "Acme",
			elements: [{ id: 1, role: "textbox", name: "api_key", value: "sk-proj-abcdef1234567890ZZ" }],
		};
		const redacted = redactBrowserOutput(snapshot) as {
			url: string;
			title: string;
			elements: { id: number; role: string; name: string; value: string }[];
		};
		// Bare token values (no key= context) get partial shape-masking, never
		// the full secret.
		expect(redacted.elements[0].value).toContain("...");
		expect(redacted.elements[0].value).not.toContain("abcdef1234567890ZZ");
		expect(redacted.url).toBe("https://example.com/");
	});

	it("collapses aliased objects into one redacted copy (no raw second reference)", () => {
		const inner = { token: "ghp_ABCDEFGHIJKLMNOPQRST1234" };
		const out = redactBrowserOutput({ a: inner, b: inner, list: [inner, inner] }) as {
			a: { token: string };
			b: { token: string };
			list: { token: string }[];
		};
		expect(JSON.stringify(out)).not.toContain("ABCDEFGHIJKLMNOPQRST1234");
		// Identity is preserved: every alias points at the SAME masked copy.
		expect(out.b).toBe(out.a);
		expect(out.list[0]).toBe(out.a);
		expect(out.list[1]).toBe(out.a);
		expect(out.a.token).toBe("ghp_AB...1234");
	});

	it("terminates a self-cycle against the redacted copy", () => {
		const node: Record<string, unknown> = { secret: "ghp_ABCDEFGHIJKLMNOPQRST1234" };
		node.self = node;
		const out = redactBrowserOutput(node) as Record<string, unknown>;
		// The cycle must point at the masked copy, never the raw original.
		expect(out.self).toBe(out);
		expect(out.secret).toBe("ghp_AB...1234");
	});

	it("masks a string value whose object key names a credential", () => {
		// `{ api_key: "..." }` carries no `api_key=` text, so no assignment pass
		// can see it — the key name is the only credential context.
		const out = redactBrowserOutput({ api_key: "SuperSecretValue18", note: "SuperSecretValue18" }) as {
			api_key: string;
			note: string;
		};
		expect(out.api_key).toBe("SuperS...ue18");
		// A neutral key is not masked by name (text passes still apply).
		expect(out.note).toBe("SuperSecretValue18");
	});

	it("keeps env-lookup expressions intact under a secret key", () => {
		const out = redactBrowserOutput({ token: "process.env.MY_TOKEN" }) as { token: string };
		expect(out.token).toBe("process.env.MY_TOKEN");
	});
});

describe("browser-output redaction: header/cookie family and gate edges", () => {
	it("masks credential-bearing JSON fields beyond the api-key name list", () => {
		expect(redactBrowserText('{"cookie": "sessionid=abcdefghijklmnop"}')).toBe('{"cookie": "sessio...mnop"}');
		expect(redactBrowserText('{"set-cookie": "abc123def456ghi789jkl; HttpOnly"}')).not.toContain("abc123def456ghi789jkl");
		expect(redactBrowserText('{"authorization": "Bearer abcdefghijklmnop1234"}')).not.toContain("abcdefghijklmnop1234");
		expect(redactBrowserText('{"x-api-key": "abcdefABCDEF0123456789"}')).not.toContain("abcdefABCDEF0123456789");
	});

	it("masks a bare cookie-jar body but not URL query params", () => {
		const jar = "sid=abcdefghijklmnop; csrf_token=zzzzzzzzzzzzzzzz1234";
		const masked = redactBrowserText(jar);
		expect(masked).not.toContain("abcdefghijklmnop");
		expect(masked).not.toContain("zzzzzzzzzzzzzzzz1234");
		// hermes parity: magic-link / OAuth query params round-trip.
		expect(redactBrowserText("https://x.test/cb?state=abcdefghijklmnop&code=123")).toBe(
			"https://x.test/cb?state=abcdefghijklmnop&code=123",
		);
	});

	it("masks userinfo in a protocol-relative reference", () => {
		expect(redactBrowserText("link //admin:hunter2pass@internal.example/x")).toContain(":***@");
		expect(redactBrowserText("link //admin:hunter2pass@internal.example/x")).not.toContain("hunter2pass");
	});

	it("catches vendor prefixes split by control bytes inside the prefix itself", () => {
		// zero-width space between `sk` and `-`: the substring pre-screen must
		// run on a control-stripped copy or this token escapes entirely.
		const split = `sk\u200b-proj-abcdef1234567890ZZ`;
		expect(redactBrowserText(split)).not.toContain("abcdef1234567890ZZ");
		// control inside the token body (already covered by hermes' pass)
		expect(redactBrowserText("sk-proj-\u001babcdef1234567890ZZ")).not.toContain("abcdef1234567890ZZ");
		// control at the very end, where the line guard could skip the span
		expect(redactBrowserText(`sk-proj-abcdef1234567890ZZ\u200b`)).not.toContain("abcdef1234567890ZZ");
	});
});