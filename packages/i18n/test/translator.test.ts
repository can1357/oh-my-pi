import { describe, expect, it } from "bun:test";
import { createI18n, type MessageKey } from "../src";

describe("translator", () => {
	it("interpolates values and selects plural branches", () => {
		const en = createI18n("en");
		const zh = createI18n("zh-CN");

		expect(en.t("common.greeting", { name: "Ada" })).toBe("Hello, Ada");
		expect(en.t("common.fileCount", { count: 1 })).toBe("1 file");
		expect(en.t("common.fileCount", { count: 2 })).toBe("2 files");
		expect(zh.t("common.fileCount", { count: 2 })).toBe("2 个文件");
	});

	it("formats numbers with the active locale", () => {
		expect(createI18n("en").number(1234567)).toBe("1,234,567");
		expect(createI18n("zh-CN").number(1234567)).toBe("1,234,567");
	});

	it("reports missing keys while returning a safe fallback", () => {
		const missingKeys: string[] = [];
		const i18n = createI18n("zh-CN", { onMissingKey: key => missingKeys.push(key) });
		expect(i18n.t("common.missing" as MessageKey)).toBe("Translation unavailable");
		expect(missingKeys).toEqual(["common.missing"]);
	});
});
