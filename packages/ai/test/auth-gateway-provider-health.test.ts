import { describe, expect, it } from "bun:test";
import { ProviderHealthBook } from "@oh-my-pi/pi-ai/auth-gateway/provider-health";

const T0 = 1_700_000_000_000;
const OPEN_EXPIRE_MS = 30_000;

describe("ProviderHealthBook", () => {
	it("starts healthy", () => {
		const book = new ProviderHealthBook();
		expect(book.state("openai", "gpt-4", T0)).toBe("healthy");
	});

	it("degrades after one provider failure and opens on the third", () => {
		const book = new ProviderHealthBook();
		book.recordFailure("openai", "gpt-4", "provider", T0);
		expect(book.state("openai", "gpt-4", T0)).toBe("degraded");
		book.recordFailure("openai", "gpt-4", "provider", T0 + 1);
		expect(book.state("openai", "gpt-4", T0 + 1)).toBe("degraded");
		book.recordFailure("openai", "gpt-4", "provider", T0 + 2);
		expect(book.state("openai", "gpt-4", T0 + 2)).toBe("open");
	});

	it("does not open after two provider failures (negative)", () => {
		const book = new ProviderHealthBook();
		book.recordFailure("openai", "gpt-4", "provider", T0);
		book.recordFailure("openai", "gpt-4", "provider", T0 + 1);
		expect(book.state("openai", "gpt-4", T0 + 1)).not.toBe("open");
		expect(book.state("openai", "gpt-4", T0 + 1)).toBe("degraded");
	});

	it("ignores credential failures so three of them stay healthy (negative)", () => {
		const book = new ProviderHealthBook();
		book.recordFailure("openai", "gpt-4", "credential", T0);
		book.recordFailure("openai", "gpt-4", "credential", T0 + 1);
		book.recordFailure("openai", "gpt-4", "credential", T0 + 2);
		expect(book.state("openai", "gpt-4", T0 + 2)).toBe("healthy");
	});

	it("does not let credential failures push a degraded target to open (negative)", () => {
		const book = new ProviderHealthBook();
		book.recordFailure("openai", "gpt-4", "provider", T0);
		book.recordFailure("openai", "gpt-4", "provider", T0 + 1);
		book.recordFailure("openai", "gpt-4", "credential", T0 + 2);
		expect(book.state("openai", "gpt-4", T0 + 2)).toBe("degraded");
	});

	it("opens on three model failures the same way as provider failures", () => {
		const book = new ProviderHealthBook();
		book.recordFailure("openai", "gpt-4", "model", T0);
		expect(book.state("openai", "gpt-4", T0)).toBe("degraded");
		book.recordFailure("openai", "gpt-4", "model", T0 + 1);
		book.recordFailure("openai", "gpt-4", "model", T0 + 2);
		expect(book.state("openai", "gpt-4", T0 + 2)).toBe("open");
	});

	it("resets to healthy on success even while open", () => {
		const book = new ProviderHealthBook();
		book.recordFailure("openai", "gpt-4", "provider", T0);
		book.recordFailure("openai", "gpt-4", "provider", T0 + 1);
		book.recordFailure("openai", "gpt-4", "provider", T0 + 2);
		expect(book.state("openai", "gpt-4", T0 + 2)).toBe("open");
		book.recordSuccess("openai", "gpt-4", T0 + 3);
		expect(book.state("openai", "gpt-4", T0 + 3)).toBe("healthy");
	});

	it("expires open to degraded after 30s then success returns healthy", () => {
		const book = new ProviderHealthBook();
		book.recordFailure("openai", "gpt-4", "provider", T0);
		book.recordFailure("openai", "gpt-4", "provider", T0 + 1);
		book.recordFailure("openai", "gpt-4", "provider", T0 + 2);
		expect(book.state("openai", "gpt-4", T0 + 2 + OPEN_EXPIRE_MS - 1)).toBe("open");
		expect(book.state("openai", "gpt-4", T0 + 2 + OPEN_EXPIRE_MS)).toBe("degraded");
		book.recordSuccess("openai", "gpt-4", T0 + 2 + OPEN_EXPIRE_MS + 1);
		expect(book.state("openai", "gpt-4", T0 + 2 + OPEN_EXPIRE_MS + 1)).toBe("healthy");
	});

	it("keys circuits by provider NUL model so siblings stay independent (negative)", () => {
		const book = new ProviderHealthBook();
		book.recordFailure("openai", "gpt-4", "provider", T0);
		book.recordFailure("openai", "gpt-4", "provider", T0 + 1);
		book.recordFailure("openai", "gpt-4", "provider", T0 + 2);
		expect(book.state("openai", "gpt-4", T0 + 2)).toBe("open");
		expect(book.state("openai", "gpt-5", T0 + 2)).toBe("healthy");
		expect(book.state("anthropic", "gpt-4", T0 + 2)).toBe("healthy");
	});
});
