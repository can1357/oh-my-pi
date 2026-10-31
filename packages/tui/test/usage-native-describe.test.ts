import { beforeAll, describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SessionInfoOverlay } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
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
	function plain(n: NativeNode): string {
		const p = n.p as { text?: string; spans?: readonly { t: string }[] } | undefined;
		return p?.text ?? p?.spans?.map(s => s.t).join("") ?? "";
	}
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
			expect.objectContaining({ value: 0.9, style: "bar", tone: "warning" }),
			expect.objectContaining({ value: 1, style: "bar", tone: "error" }),
		]);
		const fallback = dashboard(reports).describe(plainCx);
		expect(findAll(fallback, n => n.k === "meter" || n.k === "chart")).toEqual([]);
		expect(findAll(fallback, n => n.k === "progress").map(n => n.p)).toEqual([
			expect.objectContaining({ value: 0.9, tone: "warning" }),
			expect.objectContaining({ value: 1, tone: "error" }),
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
		const left = table?.k === "table" ? table.p?.rows.map(row => row.cells.left) : undefined;
		expect(left).toEqual([
			[
				{ t: "75%", s: "mono" },
				{ t: " left", s: "dim" },
			],
			[
				{ t: "25%", s: "mono warning" },
				{ t: " left", s: "dim" },
			],
		]);
	});

	it("leads with the tightest quota and the activity's headline figures", () => {
		const now = new Date();
		const iso = (back: number): string => {
			const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		};
		const component = dashboard(
			[
				report("anthropic", "a@test", [
					limit("anthropic", "5h", "Claude 5h", 0.2, "ok"),
					limit("anthropic", "7d", "Claude Weekly", 0.9, "warning"),
				]),
			],
			undefined,
			[
				{ day: iso(0), cost: 12.5, requests: 40 },
				{ day: iso(1), cost: 30, requests: 90 },
				{ day: iso(2), cost: 4, requests: 10 },
				{ day: iso(100), cost: 200, requests: 600 },
			],
		);
		const root = component.describe(cx);
		const tiles = findAll(root, n => n.p?.role === "omp.usage.stat").map(tile =>
			findAll(tile, n => n.k === "text").map(plain),
		);
		expect(tiles).toEqual([
			["Tightest quota", "10% left", "Claude Weekly · Anthropic"],
			["Past year", "$247", "740 requests"],
			["Last 30 days", "$46.50", "140 requests"],
			["Busiest day", "$200", expect.stringMatching(/ · 600 requests$/)],
		]);
		const spark = findAll(root, n => n.k === "chart" && n.p?.kind === "spark")[0];
		expect(spark?.k === "chart" ? spark.p?.series?.length : 0).toBe(30);
		const foot = findAll(root, n => n.p?.role === "omp.usage.activity.foot")[0];
		expect(foot ? findAll(foot, n => n.k === "text").map(plain)[0] : "").toBe(
			"4 active days · longest streak 3 days",
		);
	});

	it("shows one empty state when nothing is used anywhere", () => {
		const root = dashboard([report("zai", "z@test", [limit("zai", "5h", "Usage", 0, "ok")])]).describe(cx);
		const empty = findAll(root, n => n.p?.role === "omp.usage.empty")[0];
		expect(empty ? findAll(empty, n => n.k === "text").map(plain) : []).toEqual([
			"No usage yet",
			expect.stringContaining("Quotas show here"),
			"Untouched",
			"Zai",
		]);
		expect(findAll(root, n => n.p?.role === "omp.usage.stats" || n.k === "chart")).toEqual([]);
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
			findAll(component.describe(cx), n => n.p?.role === "omp.usage.provider").map(n => n.key);
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
		const chart = findAll(component.describe(cx), n => n.k === "chart" && n.p?.kind === "heatmap")[0];
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
	const dim = (key: string): string => theme.fg("dim", `${key}:`);
	// Built per test: the theme initializes in `beforeAll`, after this block is collected.
	const fullReport = (): string =>
		`${dim("File")} /tmp/s.jsonl\n${dim("ID")} abc-123\n` +
		`\n${theme.bold("Provider")}\n${dim("Model")} claude-sonnet-4-5\n` +
		`\n${theme.bold("Messages")}\n${dim("User")} 6\n${dim("Tool Calls")} 23\n${dim("Total")} 29\n\n` +
		`${dim("Append-Only")} ${theme.fg("success", "active")} (setting: auto)\n` +
		`${theme.bold("Tokens")}\n${dim("Input")} 182,440\n${dim("Total")} 182,440\n` +
		`\n${theme.bold("Cost")}\n${dim("Total")} 0.4127\n` +
		`\n${theme.bold("MCP Servers")}\n` +
		`${dim("github")} ${theme.fg("success", "connected")} ${theme.fg("dim", "(4 tools)")}\n`;
	/** The items of each `kv` with `role`, in order. */
	const kvItems = (root: NativeNode, role: string): unknown[] =>
		findAll(root, n => n.p?.role === role).flatMap(n => (n.k === "kv" ? [n.p?.items] : []));

	it("leads with the session id, then the file, each copying its own value", () => {
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, fullReport(), () => {});
		const root = overlay.describe(cx);
		const copies = findAll(root, n => n.p?.role === "omp.info.copy");
		expect(copies.map(n => n.p?.title)).toEqual(["Copy session ID", "Copy /tmp/s.jsonl"]);
		expect(JSON.stringify(copies[0])).toContain("abc-123");
		expect(JSON.stringify(copies[1])).toContain("/tmp/s.jsonl");
		expect(JSON.stringify(root)).not.toContain("\x1b");
	});

	it("does not offer to copy an in-memory session's file", () => {
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, `${dim("File")} In-memory\n`, () => {});
		const root = overlay.describe(cx);
		expect(findAll(root, n => n.p?.role === "omp.info.copy")).toEqual([]);
		expect(JSON.stringify(root)).toContain("In-memory");
	});

	it("groups counts into a stats grid with their totals set apart, and the rest as key/value rows", () => {
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, fullReport(), () => {});
		const root = overlay.describe(cx);
		expect(findAll(root, n => n.k === "section").map(n => (n.k === "section" ? n.p?.head : undefined))).toEqual([
			"Provider",
			"Messages",
			"Tokens",
			"Cost",
			"MCP servers",
		]);
		expect(findAll(root, n => n.p?.role === "omp.info.stats")).toHaveLength(1);
		expect(kvItems(root, "omp.info.nums")).toEqual([
			[
				{ k: "User", v: [{ t: "6", s: "mono" }] },
				{ k: "Tool calls", v: [{ t: "23", s: "mono" }] },
			],
			[{ k: "Input", v: [{ t: "182,440", s: "mono" }] }],
			[{ k: "Total", v: [{ t: "$0.4127", s: "mono" }] }],
		]);
		expect(kvItems(root, "omp.info.total")).toEqual([
			[{ k: "Total", v: [{ t: "29", s: "mono" }] }],
			[{ k: "Total", v: [{ t: "182,440", s: "mono" }] }],
		]);
		// The append-only mode is a provider setting: it leaves the message counts.
		expect(kvItems(root, "omp.info.kv")).toEqual([
			[
				{ k: "Model", v: [{ t: "claude-sonnet-4-5", s: "mono" }] },
				{
					k: "Append-only",
					v: [
						{ t: "active", s: "success mono" },
						{ t: " (setting: auto)", s: "mono" },
					],
				},
			],
		]);
		expect(kvItems(root, "omp.info.names")).toEqual([
			[{ k: "github", v: [{ t: "connected", s: "success" }, { t: " " }, { t: "(4 tools)", s: "dim" }] }],
		]);
	});

	it("shows the context window as a figure over a meter, or a progress bar without meters", () => {
		const context = { tokens: 41_200, contextWindow: 200_000, percent: 20.6 };
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, fullReport(), () => {}, context);
		const root = overlay.describe(cx);
		const [meter] = findAll(root, n => n.k === "meter");
		expect(meter?.p).toEqual(
			expect.objectContaining({ value: expect.closeTo(0.206, 6), title: "41,200 of 200,000 tokens" }),
		);
		expect(JSON.stringify(findAll(root, n => n.p?.role === "omp.info.contextHead"))).toContain("41K / 200K");
		const plain = new SessionInfoOverlay({ terminal: { rows: 20 } }, fullReport(), () => {}, context).describe(
			plainCx,
		);
		expect(findAll(plain, n => n.k === "meter")).toEqual([]);
		expect(findAll(plain, n => n.k === "progress")).toHaveLength(1);
	});

	it("closes from the Close button like Esc", () => {
		let closed = 0;
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, "", () => closed++);
		overlay.handleNativeEvent({ type: "action", key: "actions/close", act: "close", mods: [] });
		expect(closed).toBe(1);
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
		const timestamp = new Date(2026, 0, 1, 18, 5, 9);
		const block = createUsageRowBlock(usage, 2000, undefined, timestamp.getTime());
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
		const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: true });
		const clockWithSeconds = new Intl.DateTimeFormat(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: true,
		});
		expect(twelve.line).toContain(`"${clock.format(timestamp)} · `);
		expect(twelve.title).toBe(`2026-01-01 ${clockWithSeconds.format(timestamp)}`);
		const twentyFour = shown(false);
		expect(twentyFour.line).toContain('"18:05 · ');
		expect(twentyFour.title).toBe("2026-01-01 18:05:09");
		expect(shown(undefined).title).toBe("2026-01-01 18:05:09");
	});
});
