import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	MAILBOX_ADDRESS_PATTERN,
	mailboxAddress,
	mailboxConversationSuffix,
	mailboxSlug,
} from "@oh-my-pi/pi-coding-agent/mailbox/protocol";

describe("mailbox addresses", () => {
	it("normalizes a directory basename without leaking parent directories", () => {
		expect(mailboxSlug(path.join("parent", "--Hello_World!!"))).toBe("hello-world");
	});

	it("uses omp for unicode-only and empty basenames", () => {
		expect(mailboxSlug(path.join("parent", "日本語"))).toBe("omp");
		expect(mailboxSlug("")).toBe("omp");
	});

	it("caps the slug at 32 characters and trims a separator exposed by the cap", () => {
		expect(mailboxSlug("a".repeat(40))).toBe("a".repeat(32));
		expect(mailboxSlug(`${"a".repeat(31)}-suffix`)).toBe("a".repeat(31));
	});

	it("uses the UUID tail, not its shared timestamp prefix, for process and conversation addresses", () => {
		const id = "019a1234-5678-7000-8000-012345abcdef";
		const address = mailboxAddress("Hello", id);
		expect(address).toBe("hello-45abcdef");
		expect(mailboxConversationSuffix(id)).toBe("45abcdef");
		expect(MAILBOX_ADDRESS_PATTERN.test(`${address}.0123abcd`)).toBe(true);
		expect(MAILBOX_ADDRESS_PATTERN.test(`${address}.not-hex`)).toBe(false);
	});
});
