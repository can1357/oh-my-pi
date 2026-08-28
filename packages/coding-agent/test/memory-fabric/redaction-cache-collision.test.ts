import { describe, expect, it } from "bun:test";

import { SecretRedactor } from "@oh-my-pi/pi-coding-agent/memory-fabric/redaction";

// "Aa" and "BB" are the classic 32-bit rolling-hash collision pair
// (h = h * 31 + charCode): both hash to the same value and share a length,
// so the cache key the redactor used to derive from `${length}:${hash}` was
// identical for both inputs. Appending either pair to a common prefix
// preserves the collision, which lets us cover secret-bearing inputs too.
describe("SecretRedactor cache keying", () => {
	it("does not return one input's result for a hash-colliding other input", () => {
		const redactor = new SecretRedactor();
		const first = redactor.redact("Aa");
		const second = redactor.redact("BB");

		expect(first.redacted).toBe("Aa");
		expect(second.redacted).toBe("BB");
		expect(second).not.toBe(first);
	});

	it("redacts each of two colliding secret-bearing inputs on its own merits", () => {
		const key = `sk-${"a1B2c3D4".repeat(5)}`;
		const redactor = new SecretRedactor();
		const first = redactor.redact(`${key} Aa`);
		const second = redactor.redact(`${key} BB`);

		expect(first.redacted).toBe("[REDACTED:OPENAI_KEY] Aa");
		expect(second.redacted).toBe("[REDACTED:OPENAI_KEY] BB");
	});

	it("still serves cache hits per exact input after a collision", () => {
		const redactor = new SecretRedactor();
		const first = redactor.redact("Aa");
		redactor.redact("BB");

		expect(redactor.redact("Aa")).toBe(first);
		expect(redactor.redact("BB").redacted).toBe("BB");
	});
});
