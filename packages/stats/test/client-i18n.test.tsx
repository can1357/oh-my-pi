import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageSelector } from "../src/client/app/LanguageSelector";
import { NavRail } from "../src/client/app/NavRail";
import { RangeControl } from "../src/client/app/RangeControl";
import { EmptyState } from "../src/client/ui/EmptyState";
import { ErrorState } from "../src/client/ui/ErrorState";
import { JsonBlock } from "../src/client/ui/JsonBlock";
import { formatRelativeTime } from "../src/client/data/formatters";
import { StatsI18nProvider } from "../src/client/i18n";

describe("stats client i18n", () => {
	it("renders navigation and language controls in Chinese without changing route ids", () => {
		const html = renderToStaticMarkup(
			<StatsI18nProvider initialPreference="zh-CN">
				<NavRail activeSection="overview" onSectionChange={() => {}} />
				<LanguageSelector />
			</StatsI18nProvider>,
		);

		expect(html).toContain("概览");
		expect(html).toContain("语言");
		expect(html).toContain('value="zh-CN"');
		 expect(html).toContain('data-active="true"');
	});

	it("translates shared dashboard states and controls", () => {
		const html = renderToStaticMarkup(
			<StatsI18nProvider initialPreference="zh-CN">
				<EmptyState />
				<ErrorState onRetry={() => {}} />
				<RangeControl value="all" onChange={() => {}} />
				<JsonBlock data={{ ok: true }} />
			</StatsI18nProvider>,
		);

		expect(html).toContain("暂无数据");
		expect(html).toContain("加载数据失败");
		expect(html).toContain("重试");
		expect(html).toContain("选择时间范围");
		expect(html).toContain(">全部<");
		expect(html).toContain(">复制<");
		expect(html).not.toContain(">Retry<");
	});

	it("formats relative times with the requested locale", () => {
		expect(formatRelativeTime(Date.now() - 60_000, "zh-CN")).toContain("分钟");
	});
});
