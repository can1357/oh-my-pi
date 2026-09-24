import { describe, expect, it } from "bun:test";
import { normalizeLocale, resolveLocale } from "../src/locale";

describe("locale resolution", () => {
	it("normalizes Chinese aliases and rejects unsupported locales", () => {
		expect(normalizeLocale("zh")).toBe("zh-CN");
		expect(normalizeLocale("zh-CN")).toBe("zh-CN");
		expect(normalizeLocale("zh_CN.UTF-8")).toBe("zh-CN");
		expect(normalizeLocale("en_US.UTF-8")).toBe("en");
		expect(normalizeLocale("zh_TW.UTF-8")).toBeUndefined();
		expect(normalizeLocale("fr-FR")).toBeUndefined();
	});

	it("uses explicit preference before environment preferences", () => {
		expect(resolveLocale({ explicit: "en", configured: "zh-CN", environment: ["zh-CN"] })).toBe("en");
		expect(resolveLocale({ explicit: "auto", configured: "auto", environment: ["zh-CN"] })).toBe("zh-CN");
	});

	it("falls back to English when every preference is unsupported", () => {
		expect(resolveLocale({ explicit: "auto", configured: "auto", environment: ["fr-FR"] })).toBe("en");
	});
});
