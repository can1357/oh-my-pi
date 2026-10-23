/**
 * The paid-usage preview. Run it through `../usage-paid-preview.ts`, which
 * gives it a throwaway home directory; see that file for the modes.
 */
import { parseArgs, stripVTControlCharacters } from "node:util";
import {
	type AuthAccountPolicy,
	AuthStorage,
	openaiCodexUsageProvider,
	parseClaudeUsagePayload,
	SqliteAuthCredentialStore,
	type UsageProvider,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { EXTRA_USAGE_BLOCK_SCOPE, providerTypeKey } from "@oh-my-pi/pi-ai/auth/blocks";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import type { NativeChild } from "@oh-my-pi/pi-tui/native/node";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { ansi256ToHex } from "@oh-my-pi/pi-tui/theme/color";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";
import { logger } from "@oh-my-pi/pi-utils";
import { formatUsageBreakdown, type UsagePolicyDiagnosticsOptions } from "../../src/cli/usage-cli";
import { renderUsageReports } from "../../src/modes/controllers/command-controller";
import { renderAcpUsageReports } from "../../src/slash-commands/helpers/usage-report";
import { collectStoredAccounts, selectReportableAccounts } from "../../src/slash-commands/helpers/usage-accounts";

const HOUR = 3_600_000;
const YEAR = 365 * 24 * HOUR;

type PaidPolicy = Pick<AuthAccountPolicy, "extraUsageFloor" | "extraUsageBudget">;

/** A Claude account from the case matrix: plan windows, the `spend` block, and its policy. */
interface ClaudeAccount {
	alias: string;
	plan: { fiveHour: number; sevenDay: number };
	spend?: { enabled: false } | { used: number; cap: number | null };
	/** How long before the fetch the provider measured the payload. */
	payloadAgeMs?: number;
	/** The provider refused paid usage this long ago from now on. */
	refusedForMs?: number;
	policy?: PaidPolicy;
}

/** A Codex account from the case matrix: plan windows, the `credits` block, and its policy. */
interface CodexAccount {
	alias: string;
	plan: { primary: number; secondary: number };
	credits: Record<string, unknown>;
	policy?: PaidPolicy;
}

const CLAUDE: readonly ClaudeAccount[] = [
	{
		alias: "A1",
		plan: { fiveHour: 20, sevenDay: 64 },
		spend: { used: 190.74, cap: 200 },
		policy: { extraUsageFloor: 10 },
	},
	{
		alias: "A2",
		plan: { fiveHour: 35, sevenDay: 48 },
		spend: { used: 150, cap: 200 },
		policy: { extraUsageFloor: 10, extraUsageBudget: 400 },
	},
	{
		alias: "A3",
		plan: { fiveHour: 10, sevenDay: 81 },
		spend: { used: 350, cap: null },
		policy: { extraUsageBudget: 400 },
	},
	{ alias: "A4", plan: { fiveHour: 55, sevenDay: 72 }, spend: { used: 119.85, cap: null } },
	{ alias: "A5", plan: { fiveHour: 100, sevenDay: 90 }, spend: { used: 100, cap: 200 }, refusedForMs: 3 * HOUR },
	{ alias: "A6", plan: { fiveHour: 5, sevenDay: 30 }, spend: { enabled: false }, policy: { extraUsageFloor: 10 } },
	{ alias: "A7", plan: { fiveHour: 15, sevenDay: 22 } },
	{ alias: "A8", plan: { fiveHour: 100, sevenDay: 100 }, spend: { used: 200, cap: 200 }, payloadAgeMs: 2 * HOUR },
];

const CODEX: readonly CodexAccount[] = [
	{
		alias: "C1",
		plan: { primary: 30, secondary: 55 },
		credits: { has_credits: true, unlimited: false, balance: "489.25" },
		policy: { extraUsageFloor: 200 },
	},
	{ alias: "C2", plan: { primary: 12, secondary: 40 }, credits: { has_credits: true, unlimited: true } },
	{ alias: "C3", plan: { primary: 45, secondary: 60 }, credits: { has_credits: false, unlimited: false } },
	{
		alias: "C4",
		plan: { primary: 100, secondary: 88 },
		credits: { has_credits: true, unlimited: false },
		policy: { extraUsageFloor: 50 },
	},
	{
		alias: "C5",
		plan: { primary: 70, secondary: 95 },
		credits: { has_credits: true, unlimited: false, balance: "0" },
	},
];

const email = (alias: string): string => `${alias.toLowerCase()}@example.test`;
const bearer = (alias: string): string => `token-${alias.toLowerCase()}`;

function money(amount: number): { amount_minor: number; currency: "USD"; exponent: 2 } {
	return { amount_minor: Math.round(amount * 100), currency: "USD", exponent: 2 };
}

/** The account's `/api/oauth/usage` body as Anthropic returns it. */
function claudePayload(account: ClaudeAccount, measuredAt: number): Record<string, unknown> {
	const resetsIn = (hours: number): string => new Date(measuredAt + hours * HOUR).toISOString();
	const spend = account.spend;
	return {
		five_hour: { utilization: account.plan.fiveHour, resets_at: resetsIn(3) },
		seven_day: { utilization: account.plan.sevenDay, resets_at: resetsIn(80) },
		...(spend === undefined
			? {}
			: "enabled" in spend
				? { spend: { enabled: false } }
				: {
						spend: {
							enabled: true,
							used: money(spend.used),
							limit: spend.cap === null ? null : money(spend.cap),
						},
					}),
	};
}

/** The account's `/wham/usage` body as Codex returns it. */
function codexPayload(account: CodexAccount): Record<string, unknown> {
	const limitReached = account.plan.primary >= 100;
	return {
		rate_limit: {
			allowed: !limitReached,
			limit_reached: limitReached,
			primary_window: {
				used_percent: account.plan.primary,
				limit_window_seconds: 18_000,
				reset_after_seconds: 7_200,
			},
			secondary_window: {
				used_percent: account.plan.secondary,
				limit_window_seconds: 604_800,
				reset_after_seconds: 302_400,
			},
		},
		credits: account.credits,
	};
}

/** Claude usage straight from the payload parser the live provider uses, measured `payloadAgeMs` ago. */
const claudeUsage: UsageProvider = {
	id: "anthropic",
	async fetchUsage(params) {
		const account = CLAUDE.find(entry => email(entry.alias) === params.credential.email);
		if (!account) return null;
		const measuredAt = Date.now() - (account.payloadAgeMs ?? 0);
		return parseClaudeUsagePayload(
			claudePayload(account, measuredAt),
			{ accountId: params.credential.accountId, email: params.credential.email },
			undefined,
			measuredAt,
		);
	},
};

/** `/wham/usage` per bearer token; every other request (verified access, reset credits) is a 404. */
const usageFetch = Object.assign(
	async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
		const account = CODEX.find(entry => bearer(entry.alias) === token);
		if (!account || !url.pathname.endsWith("/wham/usage")) return new Response("not found", { status: 404 });
		return Response.json(codexPayload(account));
	},
	{ preconnect: fetch.preconnect },
);

function credential(alias: string) {
	return {
		type: "oauth" as const,
		access: bearer(alias),
		refresh: `refresh-${alias.toLowerCase()}`,
		expires: Date.now() + YEAR,
		email: email(alias),
		accountId: alias,
	};
}

async function createStorage(): Promise<AuthStorage> {
	const policies: AuthAccountPolicy[] = [
		...CLAUDE.flatMap(account =>
			account.policy ? [{ provider: "anthropic", account: { email: email(account.alias) }, ...account.policy }] : [],
		),
		...CODEX.flatMap(account =>
			account.policy
				? [{ provider: "openai-codex", account: { email: email(account.alias) }, ...account.policy }]
				: [],
		),
	];
	const storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"), {
		usageProviderResolver: provider =>
			provider === "anthropic" ? claudeUsage : provider === "openai-codex" ? openaiCodexUsageProvider : undefined,
		usageFetch,
		accountPolicies: policies,
	});
	await storage.credentials.set(
		"anthropic",
		CLAUDE.map(account => credential(account.alias)),
	);
	await storage.credentials.set(
		"openai-codex",
		CODEX.map(account => credential(account.alias)),
	);
	for (const account of CLAUDE) {
		if (account.refusedForMs === undefined) continue;
		const stored = storage.oauth.accounts("anthropic").find(entry => entry.email === email(account.alias));
		if (!stored) throw new Error(`Fixture account ${account.alias} was not stored`);
		storage.blocks.upsert({
			credentialId: stored.credentialId,
			providerKey: providerTypeKey("anthropic", "oauth"),
			blockScope: EXTRA_USAGE_BLOCK_SCOPE,
			blockedUntilMs: Date.now() + account.refusedForMs,
		});
	}
	return storage;
}

/** The `/usage` dashboard wired the way `showUsageDashboard` wires it. */
function createDashboard(
	storage: AuthStorage,
	reports: UsageReport[],
	host: { requestRender: () => void; onClose: () => void },
): UsageDashboardComponent {
	return new UsageDashboardComponent({
		reports,
		paidUsage: current => storage.usage.paidUsage(current),
		renderDetail: (width, current, paid) =>
			renderUsageReports(current, theme, Date.now(), width, undefined, [], [], paid, false),
		loadActivity: async push => push([]),
		refresh: async () => {
			await storage.usage.invalidate();
			return storage.usage.reports();
		},
		requestRender: host.requestRender,
		onClose: host.onClose,
	});
}

function setTerminalRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

/** The dashboard's ANSI frame, as tall as its content: no scrolling, no padding rows. */
function renderFrame(dashboard: UsageDashboardComponent, width: number): string[] {
	const probeRows = 1_000;
	setTerminalRows(probeRows);
	const probe = dashboard.render(width);
	// Chrome around the body: top border and header above; divider, footer and bottom border below.
	let padding = 0;
	for (let index = probe.length - 4; index > 1; index--) {
		if (stripVTControlCharacters(probe[index]!).slice(1, -1).trim()) break;
		padding++;
	}
	setTerminalRows(probeRows - padding);
	return [...dashboard.render(width)];
}

const BASIC_COLORS = [
	"#000000",
	"#cd3131",
	"#0dbc79",
	"#e5e510",
	"#2472c8",
	"#bc3fbc",
	"#11a8cd",
	"#e5e5e5",
	"#666666",
	"#f14c4c",
	"#23d18b",
	"#f5f543",
	"#3b8eea",
	"#d670d6",
	"#29b8db",
	"#ffffff",
];
const PAGE_BACKGROUND = "#16161e";
const DEFAULT_FOREGROUND = "#e5e5e7";

interface SgrState {
	fg?: string;
	bg?: string;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	strike: boolean;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Apply one SGR parameter list to `state`. */
function applySgr(state: SgrState, params: string): void {
	const codes = params === "" ? [0] : params.split(/[;:]/).map(Number);
	for (let index = 0; index < codes.length; index++) {
		const code = codes[index]!;
		if (code === 0)
			Object.assign(state, {
				fg: undefined,
				bg: undefined,
				bold: false,
				dim: false,
				italic: false,
				underline: false,
				inverse: false,
				strike: false,
			});
		else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 4) state.underline = true;
		else if (code === 7) state.inverse = true;
		else if (code === 9) state.strike = true;
		else if (code === 21 || code === 22) state.bold = state.dim = false;
		else if (code === 23) state.italic = false;
		else if (code === 24) state.underline = false;
		else if (code === 27) state.inverse = false;
		else if (code === 29) state.strike = false;
		else if (code >= 30 && code <= 37) state.fg = BASIC_COLORS[code - 30];
		else if (code >= 90 && code <= 97) state.fg = BASIC_COLORS[code - 82];
		else if (code >= 40 && code <= 47) state.bg = BASIC_COLORS[code - 40];
		else if (code >= 100 && code <= 107) state.bg = BASIC_COLORS[code - 92];
		else if (code === 39) state.fg = undefined;
		else if (code === 49) state.bg = undefined;
		else if (code === 38 || code === 48) {
			let color: string | undefined;
			if (codes[index + 1] === 2) {
				const [r, g, b] = codes.slice(index + 2, index + 5).map(value => value.toString(16).padStart(2, "0"));
				color = `#${r}${g}${b}`;
				index += 4;
			} else if (codes[index + 1] === 5) {
				color = ansi256ToHex(codes[index + 2]!);
				index += 2;
			}
			if (code === 38) state.fg = color;
			else state.bg = color;
		}
	}
}

function spanStyle(state: SgrState): string {
	const fg = state.inverse ? (state.bg ?? PAGE_BACKGROUND) : (state.fg ?? DEFAULT_FOREGROUND);
	const bg = state.inverse ? (state.fg ?? DEFAULT_FOREGROUND) : state.bg;
	const style = [`color:${fg}`];
	if (bg) style.push(`background:${bg}`);
	if (state.bold) style.push("font-weight:700");
	if (state.dim) style.push("opacity:.62");
	if (state.italic) style.push("font-style:italic");
	const decorations = [state.underline ? "underline" : "", state.strike ? "line-through" : ""].filter(Boolean);
	if (decorations.length > 0) style.push(`text-decoration:${decorations.join(" ")}`);
	return style.join(";");
}

/** The frame as a self-contained page: truecolor SGR as styled spans on a dark background. */
function frameToHtml(lines: readonly string[], title: string): string {
	const state: SgrState = { bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
	const body = lines.map(line => {
		let html = "";
		let cursor = 0;
		// SGR sequences restyle; any other escape (OSC 8 links) is dropped.
		for (const match of line.matchAll(/\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g)) {
			const text = line.slice(cursor, match.index);
			if (text) html += `<span style="${spanStyle(state)}">${escapeHtml(text)}</span>`;
			if (match[1] !== undefined) applySgr(state, match[1]);
			cursor = match.index + match[0].length;
		}
		const rest = line.slice(cursor);
		if (rest) html += `<span style="${spanStyle(state)}">${escapeHtml(rest)}</span>`;
		return html;
	});
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
html,body{margin:0;background:${PAGE_BACKGROUND}}
pre{margin:0;padding:16px;display:inline-block;font:14px/1.25 "SF Mono",Menlo,"DejaVu Sans Mono",Consolas,monospace;font-variant-ligatures:none;color:${DEFAULT_FOREGROUND};white-space:pre}
</style>
</head>
<body><pre>${body.join("\n")}</pre></body>
</html>
`;
}

/** One line per native node: kind, key and props, children indented under it. */
function describeTree(child: NativeChild, depth: number, out: string[]): void {
	const indent = "  ".repeat(depth);
	if (!("k" in child)) {
		out.push(`${indent}<component>`);
		return;
	}
	const key = child.key === undefined ? "" : `#${child.key}`;
	out.push(`${indent}${child.k}${key}${child.p === undefined ? "" : ` ${JSON.stringify(child.p)}`}`);
	for (const sub of child.c ?? []) describeTree(sub, depth + 1, out);
}

async function runInteractive(storage: AuthStorage, reports: UsageReport[]): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const { promise: closed, resolve: close } = Promise.withResolvers<void>();
	const dashboard = createDashboard(storage, reports, {
		requestRender: () => ui.requestRender(),
		onClose: () => close(),
	});
	const overlay = ui.showOverlay(dashboard, {
		anchor: "bottom-center",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
	});
	ui.setFocus(dashboard);
	ui.start();
	try {
		await closed;
	} finally {
		overlay.hide();
		ui.stop();
	}
}

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		frame: { type: "string" },
		width: { type: "string" },
		html: { type: "string" },
		cli: { type: "boolean" },
		acp: { type: "boolean" },
		native: { type: "boolean" },
	},
});
const width = Number(values.width ?? 100);
if (!Number.isInteger(width) || width < 24)
	throw new Error(`--width must be an integer of at least 24, got ${values.width}`);
if (values.frame !== undefined && values.frame !== "overview" && values.frame !== "detail") {
	throw new Error(`--frame must be overview or detail, got ${values.frame}`);
}

logger.setTransports({ console: false, file: false });
setThemeInstance(await loadTheme("dark", { mode: "truecolor" }));
const storage = await createStorage();
try {
	const reports = (await storage.usage.reports()) ?? [];
	if (values.cli) {
		const accounts = selectReportableAccounts(
			collectStoredAccounts(storage),
			provider => storage.usage.providerFor(provider) !== undefined,
		);
		const policyOptions: UsagePolicyDiagnosticsOptions = {
			globalReservePct: 10,
			getAccountPolicy: (provider, identity) => storage.oauth.policy(provider, identity),
		};
		const paid = storage.usage.paidUsage(reports);
		process.stdout.write(
			`${formatUsageBreakdown(reports, accounts, Date.now(), undefined, [], policyOptions, undefined, paid, false)}\n`,
		);
	} else if (values.acp) {
		const paid = storage.usage.paidUsage(reports);
		process.stdout.write(`${renderAcpUsageReports(reports, Date.now(), undefined, [], paid, false)}\n`);
	} else if (values.native) {
		const dashboard = createDashboard(storage, reports, { requestRender: () => {}, onClose: () => {} });
		await Bun.sleep(10);
		const cx = { cols: width, reduceMotion: true, dark: true, supports: () => true, feature: () => false };
		const out = ["# overview"];
		describeTree(dashboard.describe(cx), 0, out);
		dashboard.handleNativeEvent({ type: "select", key: "head/tabs", item: "detail" });
		out.push("", "# detail");
		describeTree(dashboard.describe(cx), 0, out);
		dashboard.dispose();
		process.stdout.write(`${out.join("\n")}\n`);
	} else if (values.frame !== undefined || values.html !== undefined) {
		const dashboard = createDashboard(storage, reports, { requestRender: () => {}, onClose: () => {} });
		await Bun.sleep(10);
		if (values.frame === "detail") dashboard.handleInput("\r");
		const lines = renderFrame(dashboard, width);
		dashboard.dispose();
		if (values.html !== undefined) {
			await Bun.write(values.html, frameToHtml(lines, `usage ${values.frame ?? "overview"} at ${width} columns`));
		} else {
			process.stdout.write(`${lines.join("\n")}\n`);
		}
	} else {
		await runInteractive(storage, reports);
	}
} finally {
	storage.close();
}
process.exit(0);
