import { beforeAll, describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SessionInfoOverlay } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { JobsPanel } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
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
		const left = table?.k === "table" ? table.p?.rows.map(row => row.cells.left) : undefined;
		expect(left).toEqual([[{ t: "75% left" }], [{ t: "25% left", s: "warning" }]]);
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
	it("turns the themed session report into headed key/value sections", () => {
		const info =
			`${theme.fg("dim", "File:")} /tmp/s.jsonl\n` +
			`\n${theme.bold("MCP Servers")}\n` +
			`${theme.fg("dim", "github:")} ${theme.fg("success", "connected")} ${theme.fg("dim", "(4 tools)")}\n`;
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, info, () => {});
		const root = overlay.describe(cx);
		const kvs = findAll(root, n => n.k === "kv").map(n => n.p);
		expect(kvs).toEqual([
			expect.objectContaining({ items: [{ k: "File", v: [{ t: "/tmp/s.jsonl" }] }] }),
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

describe("JobsPanel.describe", () => {
	const now = Date.now();
	const snapshot = {
		running: [
			{
				id: "j1",
				type: "task",
				status: "running" as const,
				label: "Audit credits",
				startTime: now - 5_000,
				agentId: "Audit",
			},
			{ id: "j2", type: "bash", status: "running" as const, label: "cargo test", startTime: now - 9_000 },
		],
		recent: [],
	};

	it("draws task jobs as agents and other jobs as dot rows, and only rows without `agent`", () => {
		const native = new JobsPanel(snapshot, now, []).describe(cx);
		expect(findAll(native, n => n.k === "agent").map(n => n.p)).toEqual([
			expect.objectContaining({ name: "Audit", status: "running", stats: { age: 5_000 } }),
		]);
		expect(findAll(native, n => n.p?.role === "omp.jobs.row").map(n => n.key)).toEqual(["j2"]);
		const plain = new JobsPanel(snapshot, now, []).describe(plainCx);
		expect(findAll(plain, n => n.k === "agent")).toEqual([]);
		expect(findAll(plain, n => n.p?.role === "omp.jobs.row").map(n => n.key)).toEqual(["j1", "j2"]);
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
});
it("masks account identities in native details, notes, Daybreak and unavailable cards and invalidates privacy toggles", () => {
	const email = "private@example.test";
	const reports: UsageReport[] = [
		{
			provider: "anthropic",
			fetchedAt: 1,
			metadata: {
				email,
				daybreak: true,
				accountId: "account-sensitive",
				orgId: "organization-sensitive",
				orgName: "Team",
			},
			notes: [`Account ${email} account-sensitive organization-sensitive`],
			resetCredits: { availableCount: 2, redeemableCount: 0, reason: email },
			limits: [{ ...limit("anthropic", "weekly", "Weekly", 0.5, "ok"), notes: [`Limit for ${email}`] }],
		},
	];
	const options = {
		reports,
		maskAccountLabels: true,
		mergeAccounts: false,
		renderDetail: () => "",
		unavailableAccounts: [{ provider: "anthropic", label: "unavailable@example.test" }],
		loadActivity: async () => {},
		requestRender: () => {},
		onClose: () => {},
	};
	const component = new UsageDashboardComponent(options);
	try {
		expect(JSON.stringify(component.describe(cx))).not.toContain(email);
		expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain(email);
		component.handleNativeEvent({ type: "select", key: "head/tabs", item: "detail" });
		const masked = component.describe(cx);
		expect(JSON.stringify(masked)).not.toContain(email);
		expect(JSON.stringify(masked)).not.toContain("unavailable@example.test");
		expect(JSON.stringify(masked)).not.toContain("account-sensitive");
		expect(JSON.stringify(masked)).not.toContain("organization-sensitive");
		expect(JSON.stringify(masked)).toContain("Team");
		component.handleNativeEvent({ type: "action", key: "head/privacy", act: "privacy", mods: [] });
		expect(JSON.stringify(component.describe(cx))).toContain(email);
		component.handleInput("p");
		expect(JSON.stringify(component.describe(cx))).not.toContain(email);
	} finally {
		component.dispose();
	}
	const reopened = new UsageDashboardComponent(options);
	try {
		expect(JSON.stringify(reopened.describe(cx))).not.toContain(email);
	} finally {
		reopened.dispose();
	}
});

it("attaches native quota labels to meters or right-side text without duplicating percentages", () => {
	for (const labelPlacement of ["moving", "right"] as const) {
		const component = new UsageDashboardComponent({
			reports: [report("anthropic", "user@example.test", [limit("anthropic", "weekly", "Weekly", 0.5, "ok")])],
			renderDetail: () => "",
			labelPlacement,
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});
		try {
			for (const context of [cx, plainCx]) {
				const view = component.describe(context);
				const gauges = findAll(view, node => node.k === "meter" || node.k === "progress");
				const percentages = findAll(view, node => node.p?.role === "omp.usage.pct");
				const gauge = gauges[0];
				const label = gauge && (gauge.k === "meter" || gauge.k === "progress") ? gauge.p?.label : undefined;
				if (labelPlacement === "moving") {
					expect(label).toEqual([{ t: "50% left" }]);
					expect(percentages).toEqual([]);
				} else {
					expect(label).toBeUndefined();
					expect(percentages).toHaveLength(1);
				}
			}
		} finally {
			component.dispose();
		}
	}
});

it("organization privacy is independent, stable across native and ANSI views, and temporary", () => {
	const organizations = ["Acme North", "Acme South"];
	const reports: UsageReport[] = organizations.map((orgName, index) => ({
		...report("anthropic", "visible@example.test", [limit("anthropic", "weekly", "Weekly", 0.5, "ok")]),
		metadata: { email: "visible@example.test", orgId: `org-${index}`, orgName, daybreak: true },
		notes: [`Notes for ${orgName}`],
		resetCredits: { availableCount: 1 },
	}));
	const options = {
		reports,
		maskAccountLabels: false,
		maskOrganizationNames: true,
		mergeAccounts: false,
		renderDetail: () => "",
		loadActivity: async () => {},
		requestRender: () => {},
		onClose: () => {},
	};
	const component = new UsageDashboardComponent(options);
	try {
		const classic = Bun.stripANSI(component.render(160).join("\n"));
		const native = JSON.stringify(component.describe(cx));
		for (const output of [classic, native]) {
			for (const name of organizations) expect(output).not.toContain(name);
			expect(output).toContain("visible@example.test");
		}
		const aliases = [...new Set(native.match(/Org-[a-f0-9]{16}/g))];
		expect(aliases).toHaveLength(2);
		component.handleNativeEvent({ type: "select", key: "head/tabs", item: "detail" });
		const details = JSON.stringify(component.describe(cx));
		for (const name of organizations) expect(details).not.toContain(name);
		for (const alias of aliases) expect(details).toContain(alias);
		component.handleInput("o");
		expect(JSON.stringify(component.describe(cx))).toContain("Acme North");
		component.handleNativeEvent({
			type: "action",
			key: "head/organization-privacy",
			act: "organization-privacy",
			mods: [],
		});
		expect(JSON.stringify(component.describe(cx))).not.toContain("Acme North");
	} finally {
		component.dispose();
	}
	const reopened = new UsageDashboardComponent(options);
	try {
		expect(JSON.stringify(reopened.describe(cx))).not.toContain("Acme North");
	} finally {
		reopened.dispose();
	}
});

it("keeps same-name organizations distinct and their aliases stable after a refresh renames them", async () => {
	const initial: UsageReport[] = ["one", "two"].map(orgId => ({
		...report("anthropic", "visible@example.test", [limit("anthropic", "weekly", "Weekly", 0.5, "ok")]),
		metadata: { email: "visible@example.test", orgName: "Shared Team", orgId },
	}));
	const fresh = initial.map((entry, index) => ({
		...entry,
		metadata: { ...entry.metadata, orgName: `Renamed ${index}` },
		limits: entry.limits.map(value => ({ ...value, label: "Refreshed" })),
	}));
	const refreshed = Promise.withResolvers<void>();
	const fetched = Promise.withResolvers<UsageReport[] | null>();
	const component: UsageDashboardComponent = new UsageDashboardComponent({
		reports: initial,
		maskOrganizationNames: true,
		mergeAccounts: false,
		renderDetail: () => "",
		refresh: () => fetched.promise,
		loadActivity: async () => {},
		requestRender: () => {
			if (component && JSON.stringify(component.describe(cx)).includes("Refreshed")) refreshed.resolve();
		},
		onClose: () => {},
	});
	try {
		const before = [...new Set(JSON.stringify(component.describe(cx)).match(/Org-[a-f0-9]{16}/g))].sort();
		expect(before).toHaveLength(2);
		component.handleInput("r");
		fetched.resolve(fresh);
		await refreshed.promise;
		const after = JSON.stringify(component.describe(cx));
		expect([...new Set(after.match(/Org-[a-f0-9]{16}/g))].sort()).toEqual(before);
		expect(after).not.toContain("Renamed 0");
		expect(after).not.toContain("Renamed 1");
	} finally {
		component.dispose();
	}
});

it("keeps quota and window labels masked when switching into native details and toggling privacy", () => {
	const email = "private@example.test";
	const orgName = "Acme North";
	const reports: UsageReport[] = [
		{
			...report("anthropic", email, [
				{ ...limit("anthropic", "weekly", email, 0.5, "ok"), window: { id: "weekly", label: orgName } },
			]),
			metadata: { email, orgName, orgId: "org-one" },
		},
	];
	const component = new UsageDashboardComponent({
		reports,
		maskAccountLabels: true,
		maskOrganizationNames: true,
		renderDetail: () => "",
		loadActivity: async () => {},
		requestRender: () => {},
		onClose: () => {},
	});
	try {
		expect(JSON.stringify(component.describe(cx))).not.toContain(email);
		component.handleNativeEvent({ type: "select", key: "head/tabs", item: "detail" });
		const masked = JSON.stringify(component.describe(cx));
		expect(masked).not.toContain(email);
		expect(masked).not.toContain(orgName);
		component.handleInput("p");
		expect(JSON.stringify(component.describe(cx))).toContain(email);
		component.handleInput("o");
		expect(JSON.stringify(component.describe(cx))).toContain(orgName);
		component.handleInput("p");
		component.handleInput("o");
		const remasked = JSON.stringify(component.describe(cx));
		expect(remasked).not.toContain(email);
		expect(remasked).not.toContain(orgName);
	} finally {
		component.dispose();
	}
});
