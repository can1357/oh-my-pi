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
		});
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
		const redacted = redactBrowserOutput(snapshot);
		// Bare token values (no key= context) get partial shape-masking, never
		// the full secret.
		expect(redacted.elements[0].value).toContain("...");
		expect(redacted.elements[0].value).not.toContain("abcdef1234567890ZZ");
		expect(redacted.url).toBe("https://example.com/");
	});
});