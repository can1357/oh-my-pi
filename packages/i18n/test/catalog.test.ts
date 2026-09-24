import { describe, expect, it } from "bun:test";
import { assertCatalogParity, assertMessagePlaceholders } from "../src/catalog";
import { EN_MESSAGES, ZH_CN_MESSAGES } from "../src/messages";

describe("message catalog validation", () => {
	it("reports missing and extra message paths", () => {
		const english = { common: { cancel: "Cancel", save: "Save" } };
		const chinese = { common: { cancel: "取消", extra: "额外" } };

		expect(() => assertCatalogParity(english, chinese, "zh-CN")).toThrow(
			"common.save: missing in zh-CN; common.extra: extra in zh-CN",
		);
	});

	it("reports placeholder mismatches", () => {
		const english = { common: { greeting: "Hello, {name}" } };
		const chinese = { common: { greeting: "你好，{user}" } };

		expect(() => assertMessagePlaceholders(english, chinese, "zh-CN")).toThrow(
			"common.greeting: placeholders differ between en and zh-CN",
		);
	});

	it("reports plural shape mismatches", () => {
		const english = { common: { fileCount: { one: "{count} file", other: "{count} files" } } };
		const chinese = { common: { fileCount: "{count} 个文件" } };

		expect(() => assertCatalogParity(english, chinese, "zh-CN")).toThrow(
			"common.fileCount: message shape differs between en and zh-CN",
		);
	});

	it("accepts the shipped English and Chinese catalogs", () => {
		expect(() => assertCatalogParity(EN_MESSAGES, ZH_CN_MESSAGES, "zh-CN")).not.toThrow();
		expect(() => assertMessagePlaceholders(EN_MESSAGES, ZH_CN_MESSAGES, "zh-CN")).not.toThrow();
	});
});
