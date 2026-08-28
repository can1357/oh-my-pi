import { describe, expect, it } from "bun:test";

import {
	containsSecrets,
	redactObject,
	redactText,
	SECRET_PATTERNS,
	SecretRedactor,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/redaction";

const OPENAI_KEY = `sk-${"a1B2c3D4".repeat(5)}`;
const ANTHROPIC_KEY = `sk-ant-${"a1B2c3D4".repeat(5)}`;
const GITHUB_TOKEN = `ghp_${"Ab1Cd2".repeat(6)}`;
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("redaction", () => {
	describe("redactText", () => {
		it("redacts an OpenAI key and reports the match count", () => {
			const result = redactText(`config: ${OPENAI_KEY}`);
			expect(result.redacted).toBe("config: [REDACTED:OPENAI_KEY]");
			expect(result.hasSecrets).toBe(true);
			expect(result.redactions).toEqual([{ pattern: "openai-api-key", count: 1 }]);
		});

		it("labels an Anthropic key as Anthropic, not OpenAI", () => {
			const result = redactText(ANTHROPIC_KEY);
			expect(result.redacted).toBe("[REDACTED:ANTHROPIC_KEY]");
			expect(result.redactions[0]?.pattern).toBe("anthropic-api-key");
		});

		it("redacts GitHub tokens, JWTs and database URLs", () => {
			expect(redactText(GITHUB_TOKEN).redacted).toBe("[REDACTED:GITHUB_TOKEN]");
			expect(redactText(JWT).redacted).toBe("[REDACTED:JWT]");
			expect(redactText("postgresql://admin:hunter2@db.internal:5432/app").redacted).toBe("[REDACTED:POSTGRES_URL]");
		});

		it("redacts private key blocks", () => {
			const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
			expect(redactText(block).redacted).toBe("[REDACTED:PRIVATE_KEY]");
		});

		it("redacts env assignments only for sensitive keys", () => {
			const result = redactText("DB_PASSWORD=hunter2\nLOG_LEVEL=debug");
			expect(result.redacted).toBe("DB_PASSWORD=[REDACTED]\nLOG_LEVEL=debug");
			expect(result.redactions).toEqual([{ pattern: "env-assignment", count: 1 }]);
		});

		it("counts multiple matches of the same pattern", () => {
			const result = redactText(`${OPENAI_KEY} and ${OPENAI_KEY}`);
			expect(result.redactions).toEqual([{ pattern: "openai-api-key", count: 2 }]);
		});

		it("does not treat a bare git SHA as an AWS secret", () => {
			const sha = "50839007861adba061ef9985a1d0a44c5476493a";
			const result = redactText(`deployed commit ${sha}`);
			expect(result.redacted).toContain(sha);
			expect(result.hasSecrets).toBe(false);
		});

		it("redacts a contextual AWS secret assignment", () => {
			const result = redactText("aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY");
			expect(result.redacted).toBe("[REDACTED:AWS_SECRET]");
		});

		it("leaves clean text untouched", () => {
			const result = redactText("plain prose with no credentials at all");
			expect(result.redacted).toBe("plain prose with no credentials at all");
			expect(result.hasSecrets).toBe(false);
			expect(result.redactions).toHaveLength(0);
		});
	});

	describe("containsSecrets", () => {
		it("agrees with redactText and is stable across repeated calls", () => {
			expect(containsSecrets(OPENAI_KEY)).toBe(true);
			expect(containsSecrets(OPENAI_KEY)).toBe(true);
			expect(containsSecrets("nothing to see")).toBe(false);
		});
	});

	describe("redactObject", () => {
		it("replaces values under sensitive keys wholesale", () => {
			const result = redactObject({ apiKey: "value", note: "safe" });
			expect(result.apiKey).toBe("[REDACTED]");
			expect(result.note).toBe("safe");
		});

		it("redacts strings nested in objects and arrays", () => {
			const result = redactObject({ outer: { logs: [`saw ${OPENAI_KEY}`, 42] } });
			const outer = result.outer as { logs: unknown[] };
			expect(outer.logs[0]).toBe("saw [REDACTED:OPENAI_KEY]");
			expect(outer.logs[1]).toBe(42);
		});

		it("does not mutate the input object", () => {
			const input = { nested: { token: "abc" } };
			redactObject(input);
			expect(input.nested.token).toBe("abc");
		});
	});

	describe("SecretRedactor", () => {
		it("returns the cached result object on repeat input", () => {
			const redactor = new SecretRedactor();
			const first = redactor.redact(OPENAI_KEY);
			const second = redactor.redact(OPENAI_KEY);
			expect(second).toBe(first);
			redactor.clearCache();
			expect(redactor.redact(OPENAI_KEY)).not.toBe(first);
		});

		it("redacts objects through the caching path", () => {
			const redactor = new SecretRedactor();
			const result = redactor.redactObject({ payload: `token ${GITHUB_TOKEN}` });
			expect(result.payload).toBe("token [REDACTED:GITHUB_TOKEN]");
		});
	});

	describe("SECRET_PATTERNS", () => {
		it("orders the anthropic pattern before the openai pattern", () => {
			const names = SECRET_PATTERNS.map(entry => entry.name);
			expect(names.indexOf("anthropic-api-key")).toBeLessThan(names.indexOf("openai-api-key"));
		});
	});
});
