import { beforeAll, describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SessionInfoOverlay } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { computeContextBreakdown, ContextUsageView } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { DEFAULT_COMPACTION_SETTINGS } from "@oh-my-pi/pi-agent-core/compaction";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

const cx = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
/** An older terminal without the data-first kinds. */
const plainCx = { ...cx, supports: (kind: string) => !["meter", "chart", "agent"].includes(kind) };

function isNode(child: NativeChild | undefined): child is NativeNode {
	return child !== undefined && typeof child === "object" && "k" in child && typeof child.k === "string";
}

function findAll(root: NativeNode, pred: (n: NativeNode) => boolean): NativeNode[] {
	const out: NativeNode[] = [];
	const walk = (n: NativeNode): void => {
		if (pred(n)) out.push(n);
		for (const child of n.c ?? []) if (isNode(child)) walk(child);
	};
	walk(root);
	return out;
}

function report(provider: string, email: string, limits: UsageReport["limits"]): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, metadata: { email } };
}

function limit(
	provider: string,
	windowId: string,
	label: string,
	usedFraction: number,
	status: "ok" | "warning" | "exhausted",
): UsageReport["limits"][number] {
	return {
		id: `${provider}:${windowId}:${label}`,
		label,
		scope: { provider, windowId },
		window: { id: windowId, label: windowId },
		amount: { usedFraction, unit: "percent" },
		status,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("UsageDashboardComponent.describe", () => {
	function dashboard(
		reports: UsageReport[],
		refresh?: () => Promise<UsageReport[] | null>,
		activity: { day: string; cost: number; requests: number }[] = [],
		requestRender: () => void = () => {},
	): UsageDashboardComponent {
		return new UsageDashboardComponent({
			reports,
			renderDetail: () => "",
			// Pushes synchronously, so the activity is in place once constructed.
			loadActivity: async push => push(activity),
			refresh,
			requestRender: () => requestRender(),
			onClose: () => {},
		});
	}

	it("draws quota windows as meters of the used fraction, clamped on overage, and progress bars without `meter`", () => {
		const reports = [
			report("anthropic", "a@test", [
				limit("anthropic", "5h", "Claude 5h", 0.9, "warning"),
				limit("anthropic", "7d", "Claude Weekly", 1.4, "exhausted"),
			]),
		];
		const meters = findAll(dashboard(reports).describe(cx), n => n.k === "meter").map(n => n.p);
		expect(meters).toEqual([
			expect.objectContaining({ value: 1, style: "bar", tone: "error" }),
			expect.objectContaining({ value: 0.9, style: "bar", tone: "warning" }),
		]);
		const fallback = dashboard(reports).describe(plainCx);
		expect(findAll(fallback, n => n.k === "meter" || n.k === "chart")).toEqual([]);
		expect(findAll(fallback, n => n.k === "progress").map(n => n.p)).toEqual([
			expect.objectContaining({ value: 1, tone: "error" }),
			expect.objectContaining({ value: 0.9, tone: "warning" }),
		]);
	});

	it("switches to the per-account detail table when the Details tab is selected", () => {
		const component = dashboard([
			report("anthropic", "a@test", [limit("anthropic", "5h", "Claude 5h", 0.25, "ok")]),
			report("anthropic", "b@test", [limit("anthropic", "5h", "Claude 5h", 0.75, "warning")]),
		]);
		const overview = component.describe(cx);
		component.handleNativeEvent({ type: "select", key: "head/tabs", item: "detail" });
		const detail = component.describe(cx);
		expect(detail).not.toBe(overview);
		const tabs = findAll(detail, n => n.k === "tabs")[0];
		expect(tabs?.p).toEqual(expect.objectContaining({ active: "detail" }));
		// One row per account in the detail table, not the bucket mean.
		const table = findAll(detail, n => n.k === "table")[0];
		const used = table?.k === "table" ? table.p?.rows.map(row => row.cells.used) : undefined;
		expect(used).toEqual([[{ t: "25% used" }], [{ t: "75% used", s: "warning" }]]);
	});

	it("re-fetches reports from the Refresh button like the r key", async () => {
		const fresh = [report("openai", "c@test", [limit("openai", "5h", "Codex 5h", 0.5, "ok")])];
		let calls = 0;
		let fetched = Promise.withResolvers<UsageReport[] | null>();
		let onRender = (): void => {};
		const component = dashboard(
			[report("anthropic", "a@test", [limit("anthropic", "5h", "Claude 5h", 0.25, "ok")])],
			() => {
				calls++;
				return fetched.promise;
			},
			[],
			() => onRender(),
		);
		component.handleNativeEvent({ type: "action", key: "head/refresh", act: "refresh", mods: [] });
		expect(calls).toBe(1);
		const providers = (): (string | undefined)[] =>
			findAll(component.describe(cx), n => n.k === "card").map(n => n.key);
		const refreshed = Promise.withResolvers<void>();
		onRender = () => {
			if (providers()[0] === "openai") refreshed.resolve();
		};
		fetched.resolve(fresh);
		await refreshed.promise;
		expect(providers()).toEqual(["openai"]);
		fetched = Promise.withResolvers();
		component.handleInput("r");
		expect(calls).toBe(2);
	});

	it("charts a year of activity with per-day tooltips, blank after today", () => {
		const now = new Date();
		const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		const component = dashboard([], undefined, [{ day: today, cost: 0.13, requests: 2 }]);
		const chart = findAll(component.describe(cx), n => n.k === "chart")[0];
		if (chart?.k !== "chart") throw new Error("no chart");
		const weekday = (now.getDay() + 6) % 7;
		const last = chart.p?.cells?.[weekday]?.length ?? 0;
		expect(last).toBe(53);
		expect(chart.p?.cells?.[weekday]?.[52]).toBe(1);
		expect(chart.p?.tips?.[weekday]?.[52]).toMatch(/^\w{3} \d{1,2} \w{3} · \$0\.13 · 2 requests$/);
		if (weekday < 6) expect(chart.p?.cells?.[6]?.[52]).toBeNull();
		expect(chart.p?.summary).toBe("$0.13 · 2 requests · last 53 weeks");
	});
});

describe("SessionInfoOverlay.describe", () => {
	it("turns the themed session report into a copyable file row and headed key/value sections", () => {
		const info =
			`${theme.fg("dim", "File:")} /tmp/s.jsonl\n` +
			`\n${theme.bold("MCP Servers")}\n` +
			`${theme.fg("dim", "github:")} ${theme.fg("success", "connected")} ${theme.fg("dim", "(4 tools)")}\n`;
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, info, () => {});
		const root = overlay.describe(cx);
		const kvs = findAll(root, n => n.k === "kv").map(n => n.p);
		const copies = findAll(root, n => n.p?.role === "omp.info.copy");
		expect(copies.map(n => n.p?.title)).toEqual(["Copy file path"]);
		expect(JSON.stringify(copies[0])).toContain("/tmp/s.jsonl");
		expect(kvs).toEqual([
			expect.objectContaining({
				items: [
					{
						k: "github",
						v: [{ t: "connected", s: "success" }, { t: " " }, { t: "(4 tools)", s: "dim" }],
					},
				],
			}),
		]);
		const sections = findAll(root, n => n.k === "section").map(n => (n.k === "section" ? n.p?.head : undefined));
		expect(sections).toEqual(["MCP Servers"]);
		expect(JSON.stringify(root)).not.toContain("\x1b");
	});

	it("closes from the Close button like Esc", () => {
		let closed = 0;
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, "", () => closed++);
		overlay.handleNativeEvent({ type: "action", key: "actions/close", act: "close", mods: [] });
		expect(closed).toBe(1);
	});
});

describe("ContextUsageView.describe", () => {
	const breakdown = computeContextBreakdown(
		{
			model: { id: "demo", name: "Demo Model", contextWindow: 200_000 } as never,
			agent: { tokenizer: {} as never },
			getContextBreakdown: () => ({
				messagesTokens: 12_000,
				skillsTokens: 0,
				systemToolsTokens: 3_900,
				systemContextTokens: 112,
				systemPromptTokens: 2_600,
				usedTokens: 18_612,
			}),
		} as never,
		{ compaction: { ...DEFAULT_COMPACTION_SETTINGS, thresholdPercent: 85 } },
	);

	it("stacks categories, then free space as the empty track, then the hatched buffer, marked at the threshold", () => {
		const view = new ContextUsageView(breakdown, theme);
		const bar = findAll(view.describe(cx), n => n.k === "meter" && n.p?.style === "bar")[0];
		if (bar?.k !== "meter") throw new Error("no bar meter");
		const parts = bar.p?.parts ?? [];
		expect(parts.map(part => part.token)).toEqual([
			"accent",
			"warning",
			"customMessageLabel",
			"userMessageText",
			"track",
			"warning",
		]);
		expect(parts.at(-1)?.hatch).toBe(true);
		expect(parts.reduce((sum, part) => sum + part.value, 0)).toBeCloseTo(1);
		const threshold = bar.p?.marks?.[0]?.at ?? 0;
		expect(threshold).toBeCloseTo(1 - (parts.at(-1)?.value ?? 0));
	});

	it("keeps the glyph grid on terminals without `meter`", () => {
		const described = new ContextUsageView(breakdown, theme).describe(plainCx);
		expect(findAll(described, n => n.k === "meter")).toEqual([]);
		expect(findAll(described, n => n.p?.role === "omp.context.usage")).toHaveLength(1);
	});
});

describe("createUsageRowBlock describe", () => {
	it("declares throughput as a rate and omits it for sub-100ms requests", () => {
		const usage = {
			input: 100,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 600,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const fast = createUsageRowBlock(usage, 50).describe?.(cx);
		const slow = createUsageRowBlock(usage, 2000).describe?.(cx);
		if (!fast || !slow) throw new Error("usage row did not describe");
		expect(findAll(fast, n => n.k === "rate")).toEqual([]);
		expect(findAll(slow, n => n.k === "rate").map(n => n.p)).toEqual([{ value: 250, unit: "tok/s" }]);
	});

	it("shows the turn's time on the terminal's clock, re-describing when it changes", () => {
		const usage = {
			input: 100,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 600,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const block = createUsageRowBlock(usage, 2000, undefined, new Date(2026, 0, 1, 18, 5, 9).getTime());
		const shown = (hour12: boolean | undefined) => {
			const described = block.describe?.({ ...cx, hour12 });
			if (!described) throw new Error("usage row did not describe");
			const [line] = findAll(described, n => n.k === "text");
			return { line: JSON.stringify(line), title: String(described.p?.title) };
		};
		// No clock from the terminal keeps the log-style stamp.
		expect(shown(undefined).line).toContain('"18:05 · ');
		expect(shown(undefined).title).toBe("2026-01-01 18:05:09");
		const twelve = shown(true);
		expect(twelve.line).toMatch(/"0?6:05\s?pm · /i);
		expect(twelve.title).toMatch(/^2026-01-01 0?6:05:09\s?pm$/i);
		const twentyFour = shown(false);
		expect(twentyFour.line).toContain('"18:05 · ');
		expect(twentyFour.title).toBe("2026-01-01 18:05:09");
		expect(shown(undefined).title).toBe("2026-01-01 18:05:09");
	});
});
