import { describe, expect, it } from "bun:test";
import { createTranslator, englishSource } from "@oh-my-pi/pi-utils/i18n-core";

// Import the public subpath: consumers need no application bootstrap or language pack.
describe("pure translation core", () => {
	it("uses English and strips semantic context on missing messages", () => {
		const t = createTranslator({});
		expect(t("Open\u0004action.open-file")).toBe("Open");
		expect(t("Hello {0}\u0004greeting", "Ada")).toBe("Hello Ada");
		expect(t("constructor")).toBe("constructor");
		expect(t("toString")).toBe("toString");
		expect(englishSource("Open")).toBe("Open");
	});

	it("distinguishes meanings and preserves deliberately empty translations", () => {
		const t = createTranslator({
			"Open\u0004action.open-file": "열기",
			"Open\u0004status.connection": "연결됨",
			"Optional label": "",
		});
		expect(t("Open\u0004action.open-file")).toBe("열기");
		expect(t("Open\u0004status.connection")).toBe("연결됨");
		expect(t("Open\u0004another-meaning")).toBe("Open");
		expect(t("Optional label")).toBe("");
	});

	it("reorders, repeats, and omits arguments without interpreting replacement text", () => {
		const t = createTranslator({
			"{0} has {1} item{2}": "{1}개: {0}, {0}",
			"{1} item{2}": "{0}: {1}개",
		});
		expect(t("{0} has {1} item{2}", "$&{1}", "2", "s")).toBe("2개: $&{1}, $&{1}");
		expect(t("{1} item{2}", "목록", "2", "s")).toBe("목록: 2개");
		expect(t("{0} has {1} item{2}", "Ada")).toBe("{1}개: Ada, Ada");
		expect(t("Missing {0}")).toBe("Missing {0}");
	});

	it("rejects malformed packs and placeholders outside the source argument range", () => {
		for (const pack of [null, [], "text", { Hello: 3 }, { Hello: "{0}" }, { "Hi {0}": "{1}" }]) {
			expect(() => createTranslator(pack)).toThrow();
		}
		expect(() => createTranslator({ "Hi {0}": "{9007199254740992}" })).toThrow();
		expect(() => createTranslator({ "Hi {9007199254740992}": "안녕" })).toThrow();
	});

	it("isolates translators from caller mutation and inherited entries", () => {
		const pack = { Hello: "안녕" };
		const t = createTranslator(pack);
		pack.Hello = "{99}";
		expect(t("Hello")).toBe("안녕");
		expect(createTranslator({})("Hello")).toBe("Hello");
		const inherited = Object.create({ Hello: "inherited" });
		expect(createTranslator(inherited)("Hello")).toBe("Hello");
	});
});
