import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageSelector } from "../src/web/LanguageSelector";
import { MetaI18nProvider } from "../src/web/i18n";

describe("metaharness web i18n", () => {
	it("renders the language selector in Chinese without changing preference values", () => {
		const html = renderToStaticMarkup(
			<MetaI18nProvider initialPreference="zh-CN">
				<LanguageSelector />
			</MetaI18nProvider>,
		);

		expect(html).toContain("语言");
		expect(html).toContain("自动");
		expect(html).toContain('value="zh-CN"');
	});
});
