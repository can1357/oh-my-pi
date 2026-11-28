/** @jsxImportSource @oh-my-pi/pi-tui */
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import {
	type DailyActivityPoint,
	UsageDashboardModel,
	type UsageDashboardOptions,
} from "../../../../src/ui/overlays/panels/usage-dashboard-model";
import { UsageDashboard } from "../../../../src/ui/overlays/panels/usage-dashboard";
import { UsageRow, type UsageRowProps } from "../../../../src/ui/overlays/panels/usage-row";
import { type Driver, type Mounted, panelSuite } from "./harness";

process.env.TZ = "UTC";

const NOW = CORPUS_NOW;
const DAY = 86_400_000;

const limit = (
	provider: string,
	windowId: string,
	label: string,
	usedFraction: number | undefined,
	status: UsageLimit["status"],
	resetIn?: number,
): UsageLimit =>
	({
		id: `${provider}:${windowId}:${label}`,
		label,
		scope: { provider, windowId },
		window: { id: windowId, label: windowId, ...(resetIn ? { resetsAt: NOW + resetIn } : {}) },
		amount: usedFraction === undefined ? { used: 12.34, unit: "usd" } : { usedFraction, unit: "percent" },
		status,
	}) as UsageLimit;

const report = (provider: string, email: string, limits: UsageLimit[], extra: Partial<UsageReport> = {}) =>
	({ provider, fetchedAt: NOW - 90_000, limits, metadata: { email }, ...extra }) as UsageReport;

const reports = (): UsageReport[] => [
	report("anthropic", "a@test", [
		limit("anthropic", "5h", "Claude 5h", 0.9, "warning", 3_600_000),
		limit("anthropic", "7d", "Claude Weekly with a very long label that wraps", 1.4, "exhausted", DAY * 3),
		limit("anthropic", "7d", "Claude 7 Day (Fable)", 0.16, "ok"),
		limit("anthropic", "30d", "Monthly", 0.05, "ok"),
		limit("anthropic", "90d", "Quarter", 0.01, "ok"),
	]),
	report("anthropic", "b@test", [limit("anthropic", "5h", "Claude 5h", 0.3, "ok", 1_800_000)]),
	report("openai", "o@test", [
		limit("openai", "5h", "Codex 5h", 0.4, "ok"),
		limit("openai", "spend", "Spend", undefined, "ok"),
	]),
	report("google", "g@test", [limit("google", "5h", "Gemini 5h", 0, "ok")]),
	report("kimi", "k@test", [], { notes: ["no quota API"] }),
];

const isoDay = (back: number) => {
	const d = new Date(NOW - back * DAY);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const activity: DailyActivityPoint[] = [0, 1, 2, 5, 9, 40, 120, 300].map((back, i) => ({
	day: isoDay(back),
	cost: i % 3 === 0 ? 0 : i * 3.7,
	requests: i * 11,
}));

type Options = Omit<UsageDashboardOptions, "terminalRows" | "now" | "onClose">;
const missing = [
	{ provider: "openai", label: "x@test" },
	{ provider: "zai", label: "z@test" },
];
const DASHBOARDS: Record<string, Partial<Options>> = {
	full: {
		refresh: async () => ({ reports: reports().slice(0, 2), unavailableAccounts: missing }),
		unavailableAccounts: missing,
	},
	loading: { loadActivity: () => new Promise(() => {}) },
	empty: { reports: [], loadActivity: async push => push([]) },
	failed: { loadActivity: () => Promise.reject(new Error(`database locked at ${process.env.HOME}/x.db.`)) },
	stale: {
		loadActivity: async push => {
			push(activity);
			throw new Error("busy");
		},
	},
	"refresh-null": { refresh: async () => null },
	"refresh-error": { refresh: () => Promise.reject(new Error("net\ndown")) },
};

const ROWS: Record<string, UsageRowProps> = {};
{
	const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
		input,
		output,
		cacheRead,
		cacheWrite,
	});
	const stamp = new Date(2026, 0, 1, 18, 5, 9).getTime();
	ROWS["row-bare"] = { usage: usage(0, 0) };
	ROWS["row-fast"] = { usage: usage(100, 500), durationMs: 50 };
	ROWS["row-full"] = {
		usage: usage(123_456, 7_890, 12_000, 4_000),
		durationMs: 2000,
		ttftMs: 900,
		timestamp: stamp,
		turnElapsedMs: 6_200,
	};
	ROWS["row-no-throughput"] = { usage: usage(1, 0, 5), durationMs: 2000, ttftMs: 0, timestamp: stamp };
	ROWS["row-elapsed-only"] = { usage: usage(10, 10), turnElapsedMs: 347.2838 };
}

const settle = () => Bun.sleep(1);

function mountRow(props: UsageRowProps): Mounted {
	return {
		view: () => <UsageRow {...props} />,
		// The recording described with its own clock both times (the steps' contexts never reached it).
		steps: { "hour12 true": () => {}, "hour12 false": () => {} },
	};
}

function mountDashboard(options: Partial<Options>): Mounted {
	const model = new UsageDashboardModel({
		reports: reports(),
		renderDetail: (width, data) => `Detail ${width} ${data.reports.length}\n${"row\n".repeat(40)}end`,
		loadActivity: async push => push(activity),
		onClose: () => {},
		terminalRows: () => 30,
		now: () => NOW,
		...options,
	});
	const emit = (event: Parameters<Driver["emit"]>[0]) => (driver: Driver) => void driver.emit(event);
	return {
		view: () => <UsageDashboard model={model} />,
		ready: settle(),
		steps: {
			settle,
			"tab native detail": emit({ type: "select", key: "head/tabs", item: "detail" }),
			"tab native overview": emit({ type: "activate", key: "tabs", item: "overview" }),
			refresh: async driver => {
				driver.emit({ type: "action", key: "head/refresh", act: "refresh", mods: [] });
				await settle();
			},
			"r key": async driver => {
				driver.press("r");
				await settle();
			},
			r: async driver => {
				driver.press("r");
				await settle();
			},
			"refresh fail": driver => driver.press("r"),
		},
	};
}

panelSuite({
	dir: "overlays/usage-dashboard",
	mount(caseName) {
		const row = ROWS[caseName];
		if (row) return mountRow(row);
		const options = DASHBOARDS[caseName];
		if (!options) throw new Error(`unknown case ${caseName}`);
		return mountDashboard(options);
	},
});
