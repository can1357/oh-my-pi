import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	redactMemorySecrets,
	redactMemoryTextFields,
	redactRememberWrite,
} from "@oh-my-pi/pi-coding-agent/memory-backend/redact";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { TempDir } from "@oh-my-pi/pi-utils";

const NPM_TOKEN = `npm_${"a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXy".slice(0, 36)}`;
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("memory secret redaction", () => {
	it("redacts provider token shapes", () => {
		expect(redactMemorySecrets(`token is ${NPM_TOKEN} ok`)).toBe("token is [REDACTED] ok");
		expect(redactMemorySecrets(`id ${AWS_KEY}`)).toBe("id [REDACTED]");
		expect(redactMemorySecrets("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[REDACTED]");
		expect(redactMemorySecrets("xoxb-1234567890-abcdef")).toBe("[REDACTED]");
		expect(redactMemorySecrets("secret_aB3dEfGh1JkLmN0pQ")).toBe("[REDACTED]");
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(24)}.${"b".repeat(20)}`;
		expect(redactMemorySecrets(`bearer ${jwt} sent`)).toBe("bearer [REDACTED] sent");
		expect(redactMemorySecrets("version 1.2.3 released")).toBe("version 1.2.3 released");
	});

	it("leaves ordinary identifiers alone", () => {
		for (const identifier of [
			"passwordAuthenticationMiddleware",
			"tokenizationStrategy",
			"keyboardInterruptHandler",
			"token_bucket_rate_limiter",
			"secret_manager_client",
			"password_authentication",
			"token_authorization",
			"key_configuration",
		]) {
			expect(redactMemorySecrets(`calls ${identifier} twice`), identifier).toBe(`calls ${identifier} twice`);
		}
	});

	it("redacts a credential passed as the source field", () => {
		const scrubbed = redactMemoryTextFields({ content: "safe", source: `agent-${NPM_TOKEN}` });
		expect(scrubbed.source).toBe("agent-[REDACTED]");
	});

	it("redacts a letters-only credential suffix", () => {
		expect(redactMemorySecrets("use password-supersecretvalue here")).toBe("use [REDACTED] here");
		expect(redactMemorySecrets("API token-abcdefghijklmnop leaked")).toBe("API [REDACTED] leaked");
	});

	// 220 KB of one unbroken run. The earlier lookahead form took ~25s on this input and
	// would exceed the per-test timeout; a single pass returns in milliseconds.
	it("scans a large unbroken run without rescanning its tail", () => {
		const input = "token_aaaa-".repeat(20000);
		expect(redactMemorySecrets(input)).toBe(input);
	});

	it("scrubs every text-bearing field, both naming styles", () => {
		const scrubbed = redactMemoryTextFields({
			content: `a ${NPM_TOKEN}`,
			embedText: `b ${NPM_TOKEN}`,
			embed_text: `c ${NPM_TOKEN}`,
			extractText: `d ${NPM_TOKEN}`,
			extract_text: `e ${NPM_TOKEN}`,
			importance: 0.5,
		});
		for (const [key, value] of Object.entries(scrubbed)) {
			if (typeof value !== "string") continue;
			expect(value, key).not.toContain("npm_");
			expect(value, key).toContain("[REDACTED]");
		}
		expect(scrubbed.importance).toBe(0.5);
	});

	it("scrubs nested metadata, which is serialized whole into metadata_json", () => {
		const scrubbed = redactMemoryTextFields({
			content: "safe",
			metadata: { context: `auth uses ${NPM_TOKEN}`, cwd: "/work/app", nested: [`also ${NPM_TOKEN}`] },
		});
		expect(scrubbed.metadata.context).toBe("auth uses [REDACTED]");
		expect(scrubbed.metadata.nested[0]).toBe("also [REDACTED]");
		expect(scrubbed.metadata.cwd).toBe("/work/app");
		expect(scrubbed.content).toBe("safe");
	});

	it("redacts global Mnemopi memories and metadata before persistence", async () => {
		await Promise.all([loadMnemopi(), loadMnemopiCore()]);
		using dbDir = TempDir.createSync("@memory-redaction-global-");
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.dbPath": dbDir.join("mnemopi.db"),
			"mnemopi.scoping": "per-project-tagged",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.proactiveLinking": false,
			"mnemopi.autoRetain": false,
		});
		const state = new MnemopiSessionState({
			sessionId: "global-redaction",
			config: loadMnemopiConfig(settings, dbDir.path()),
			session: {} as never,
		});
		try {
			const id = state.rememberScoped(
				`global token is ${NPM_TOKEN}`,
				{ source: `agent-${NPM_TOKEN}`, metadata: { context: `auth uses ${NPM_TOKEN}` } },
				state.getGlobalRetainTarget(),
			);
			expect(state.globalMemory!.get(id!)).toMatchObject({
				content: "global token is [REDACTED]",
				source: "agent-[REDACTED]",
				metadata_json: JSON.stringify({ context: "auth uses [REDACTED]" }),
			});
		} finally {
			await state.dispose();
		}
	});

	it("handles a string memory and an absent options bag", () => {
		const [memory, options] = redactRememberWrite(`leak ${NPM_TOKEN}`, undefined);
		expect(memory).toBe("leak [REDACTED]");
		expect(options).toBeUndefined();
	});

	it("redacts nonuniform TCKNs using the tenth and eleventh digit checks independently", () => {
		expect(redactMemorySecrets("id 10000000146")).toBe("id [REDACTED:tckn]");
		// The odd/even expression is negative before modulo normalization.
		expect(redactMemorySecrets("id 19090909018")).toBe("id [REDACTED:tckn]");
		// The first checksum is wrong even though the final digit matches the sum.
		expect(redactMemorySecrets("id 10000000157")).toBe("id 10000000157");
		// The tenth digit is correct but the final checksum is wrong.
		expect(redactMemorySecrets("id 10000000145")).toBe("id 10000000145");
	});

	it("redacts an exact national IBAN span without consuming following prose", () => {
		expect(redactMemorySecrets("pay TR330006100519786457841326 and continue")).toBe("pay [REDACTED:iban] and continue");
		expect(redactMemorySecrets("pay tr33 0006 1005 1978 6457 8413 26 and continue")).toBe("pay [REDACTED:iban] and continue");
		expect(redactMemorySecrets("GB82-WEST-1234-5698-7654-32 tomorrow")).toBe("[REDACTED:iban] tomorrow");
		expect(redactMemorySecrets("TR330006100519786457841326 and GB82WEST12345698765432 tomorrow")).toBe(
			"[REDACTED:iban] and [REDACTED:iban] tomorrow",
		);
	});

	it("does not mask IBAN prefixes with invalid length, checksum, country, or token boundaries", () => {
		expect(redactMemorySecrets("TR3300061005197864578413260")).toBe("TR3300061005197864578413260");
		expect(redactMemorySecrets("TR33000610051978645784132 and continue")).toBe("TR33000610051978645784132 and continue");
		expect(redactMemorySecrets("TR340006100519786457841326 and continue")).toBe("TR340006100519786457841326 and continue");
		expect(redactMemorySecrets("XX330006100519786457841326")).toBe("XX330006100519786457841326");
		expect(redactMemorySecrets("account_TR330006100519786457841326")).toBe("account_TR330006100519786457841326");
	});

	it("redacts PII with typed masks and strict validators (no FP on bad checksums); covers TR phones, TCKN, IBAN, CC", () => {
		// email
		expect(redactMemorySecrets("reach user.name+tag@sub.example.co.uk or not")).toBe("reach [REDACTED:email] or not");

		// TR phone +90/05xx variants
		expect(redactMemorySecrets("call +905321234567")).toBe("call [REDACTED:phone]");
		expect(redactMemorySecrets("0532 123 45 67 or +90-532-123-45-67")).toBe("[REDACTED:phone] or [REDACTED:phone]");
		expect(redactMemorySecrets("phone 0532123456 short no")).toBe("phone 0532123456 short no");

		// TCKN 11dig + checksum only
		expect(redactMemorySecrets("tckn 11111111110 is valid")).toBe("tckn [REDACTED:tckn] is valid");
		expect(redactMemorySecrets("tckn 11111111111 no, 12345678901 no")).toBe("tckn 11111111111 no, 12345678901 no");

		// IBAN mod-97 incl TR
		expect(redactMemorySecrets("pay to TR330006100519786457841326")).toBe("pay to [REDACTED:iban]");
		expect(redactMemorySecrets("GB82WEST12345698765432")).toBe("[REDACTED:iban]");
		expect(redactMemorySecrets("bad TR123456789012345678901234 and XX00")).toBe("bad TR123456789012345678901234 and XX00");

		// credit card Luhn, groups
		expect(redactMemorySecrets("card 4111111111111111 ok")).toBe("card [REDACTED:credit_card] ok");
		expect(redactMemorySecrets("4111-1111-1111-1111")).toBe("[REDACTED:credit_card]");
		expect(redactMemorySecrets("4242 4242 4242 4242")).toBe("[REDACTED:credit_card]");
		expect(redactMemorySecrets("4111111111111112 bad luhn")).toBe("4111111111111112 bad luhn");
		expect(redactMemorySecrets("1234 5678 1234 5678 no")).toBe("1234 5678 1234 5678 no");

		// new secrets explicit
		expect(redactMemorySecrets("use hf_abc123def456ghi789jkl012mno345")).toBe("use [REDACTED]");
		// regression for 6 review findings
		// 1. email linear (no quadratic)
		const longish = "a@b." + "c".repeat(20) + ".com";
		expect(redactMemorySecrets("mail " + longish)).toBe("mail [REDACTED:email]");
		// 2. credential full before PII (no partial)
		expect(redactMemorySecrets("password_4111111111111111")).toBe("[REDACTED]");
		// 3. IBAN no following text swallow
		expect(redactMemorySecrets("TR330006100519786457841326.")).toBe("[REDACTED:iban].");
		// 4. TCKN dual control (use one that passes both)
		expect(redactMemorySecrets("tckn 11111111110")).toBe("tckn [REDACTED:tckn]");
		// 5. phone no code token/line match
		expect(redactMemorySecrets("code05321234567")).toBe("code05321234567");
		expect(redactMemorySecrets("v05321234567")).toBe("v05321234567");
		// 6. cc 13-19 + groups (amex 15dig)
		expect(redactMemorySecrets("amex 378282246310005")).toBe("amex [REDACTED:credit_card]");
		expect(redactMemorySecrets("13dig 1234567890123 no")).toBe("13dig 1234567890123 no"); // not luhn or short
	});
});
