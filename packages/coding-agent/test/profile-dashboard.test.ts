import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	ProfileDashboard,
	type ProfileDashboardSetupRef,
} from "@oh-my-pi/pi-coding-agent/modes/components/profile-dashboard";
import type { ProfileSnapshot } from "@oh-my-pi/pi-coding-agent/profiles/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const NOW = 1_800_000_000_000;

const CURRENT_SETUP = { kind: "current" } as const satisfies ProfileDashboardSetupRef;

function savedSetup(name: string): ProfileDashboardSetupRef {
	return { kind: "saved", name };
}

function snapshot(): ProfileSnapshot {
	return {
		generatedAt: NOW,
		roles: [
			{
				role: "default",
				selector: "anthropic/fixture-model",
				provider: "anthropic",
				modelId: "fixture-model",
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				automatic: false,
			},
		],
		agents: [],
		memory: { backend: "off", storageLabel: "Profile-local default storage" },
		settings: [],
		warnings: [],
	};
}

function setup(height = 24, savedSetupNames: readonly string[] = ["beta"]) {
	const actions: string[] = [];
	const setups = [CURRENT_SETUP, ...savedSetupNames.map(savedSetup)];
	const label = (value: ProfileDashboardSetupRef): string =>
		value.kind === "current" ? "current" : `saved:${value.name}`;
	const dashboard = new ProfileDashboard({
		setups,
		terminalHeight: height,
		callbacks: {
			requestRender: () => {},
			close: () => actions.push("close"),
			selected: value => actions.push(`select:${label(value)}`),
			loadSetup: value => {
				actions.push(`load:${value.name}`);
			},
			saveCurrentSetup: () => {
				actions.push("save");
			},
			importProfile: () => {
				actions.push("import");
			},
			exportProfile: value => {
				actions.push(`export:${label(value)}`);
			},
			deleteSetup: value => {
				actions.push(`delete:${value.name}`);
			},
			renameSetup: value => {
				actions.push(`rename:${value.name}`);
			},
			editProfile: value => {
				actions.push(`edit-profile:${label(value)}`);
			},
			openActiveControl: control => actions.push(`control:${control}`),
			unloadProfile: () => {
				actions.push("unload");
			},
		},
	});
	for (const value of setups) dashboard.setSetupState(value, { snapshot: snapshot(), loading: false });
	return { dashboard, actions };
}

function snapshotWithAgentAssignments(): ProfileSnapshot {
	const value = snapshot();
	value.agents = [
		{
			name: "scout",
			enabled: true,
			source: "bundled",
			selector: "anthropic/claude-haiku-4-5:low",
			provider: "anthropic",
			modelId: "claude-haiku-4-5",
			thinkingLevel: ThinkingLevel.Low,
		},
		{
			name: "reviewer",
			enabled: true,
			source: "profile",
			selector: "openai-codex/gpt-5.6-sol:high",
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: ThinkingLevel.High,
		},
		{
			name: "security-reviewer",
			enabled: false,
			source: "project",
			selector: "missing/security-model",
			warning: "Model selection is unresolved",
		},
		{
			name: "task",
			enabled: true,
			source: "bundled",
			selector: "fast-task",
			provider: "google",
			modelId: "gemini-3-flash",
			thinkingLevel: ThinkingLevel.Medium,
		},
		{
			name: "sonic",
			enabled: true,
			source: "user",
			selector: "openai/gpt-5.6-mini",
			provider: "openai",
			modelId: "gpt-5.6-mini",
		},
	];
	return value;
}

/** A preview tall enough to page; `lastAgent` sorts after every other agent row. */
function tallSnapshot(lastAgent = "zz-last-agent", count = 24): ProfileSnapshot {
	const value = snapshotWithAgentAssignments();
	for (let index = 1; index <= count; index++) {
		value.agents.push({
			name: index === count ? lastAgent : `filler-${String(index).padStart(2, "0")}`,
			enabled: true,
			source: "user",
			selector: "anthropic/fixture-model",
			provider: "anthropic",
			modelId: "fixture-model",
		});
	}
	return value;
}

function plain(dashboard: ProfileDashboard, width = 80): string {
	return dashboard.render(width).map(stripVTControlCharacters).join("\n");
}

function clickRenderedHint(dashboard: ProfileDashboard, width: number, text: string): void {
	const lines = dashboard.render(width).map(stripVTControlCharacters);
	const line = lines.findIndex(value => value.includes(text));
	if (line < 0) throw new Error(`Expected rendered footer action: ${text}`);
	const col = lines[line]!.indexOf(text);
	dashboard.handleInput(`\x1b[<0;${col + 1};${line + 1}M`);
}

function mouseEvent(button: 0 | 64 | 65, col: number, row: number): string {
	return `\x1b[<${button};${col + 1};${row + 1}M`;
}

function splitDividerColumn(lines: readonly string[]): number {
	for (const line of lines) {
		const setupIndex = line.indexOf("Current profile");
		if (setupIndex < 0) continue;
		const dividerIndex = line.indexOf("│", setupIndex + "Current profile".length);
		if (dividerIndex < 0) continue;
		return Bun.stringWidth(line.slice(0, dividerIndex));
	}
	throw new Error("Expected the setup list and preview to be separated");
}

function pageOverviewUntil(
	dashboard: ProfileDashboard,
	width: number,
	height: number,
	target: string,
	checkFrame?: (lines: readonly string[]) => void,
): string {
	const pages: string[] = [];
	let previous = "";
	while (true) {
		const lines = dashboard.render(width, height).map(stripVTControlCharacters);
		checkFrame?.(lines);
		const current = lines.join("\n");
		if (current === previous) throw new Error(`Overview stopped before rendering ${target}`);
		pages.push(current);
		if (current.includes(target)) return pages.join("\n");
		previous = current;
		dashboard.handleInput("\x1b[6~");
	}
}

function moveOverviewToStart(dashboard: ProfileDashboard, width: number, height: number): void {
	while (true) {
		const before = dashboard.render(width, height).map(stripVTControlCharacters).join("\n");
		dashboard.handleInput("\x1b[5~");
		const after = dashboard.render(width, height).map(stripVTControlCharacters).join("\n");
		if (after === before) return;
	}
}

beforeAll(async () => {
	await initTheme(false);
});

describe("profile dashboard interaction boundaries", () => {
	test("pages one overview from models through agents while keeping the selected setup pinned", () => {
		const { dashboard, actions } = setup(18, ["beta"]);
		dashboard.setSetupState(savedSetup("beta"), { snapshot: tallSnapshot(), loading: false });
		dashboard.handleInput("\x1b[B");
		dashboard.handleInput("\t");

		const width = 96;
		const height = 18;
		const overview = pageOverviewUntil(dashboard, width, height, "zz-last-agent", lines => {
			expect(lines).toHaveLength(height);
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			const rightPane = lines
				.map(line => {
					const divider = line.indexOf("│");
					return divider < 0 ? "" : line.slice(divider + 1);
				})
				.join("\n");
			expect(rightPane).toContain("beta");
			expect(rightPane).toContain("Saved profile");
			expect(dashboard.selectedSetup).toEqual(savedSetup("beta"));
		});
		for (const section of ["Includes:", "Models", "Agents"]) {
			expect(overview).toContain(section);
		}
		expect(overview).toContain("fixture-model");
		expect(overview).toContain("scout");
		expect(actions).toEqual(["select:saved:beta"]);

		const compact = setup(11, []).dashboard;
		compact.setActionNotice("Saved\tprofile\nwithout extra rows", "success");
		const compactLines = compact.render(80, 11);
		expect(compactLines).toHaveLength(11);
		expect(compactLines.map(stripVTControlCharacters).join("\n")).toContain("Saved profile without extra rows");
		for (const line of compactLines) {
			expect(line).not.toMatch(/[\t\r\n]/);
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	test("keeps left pointer input in the setup list and continues one overview offset over lower rows", () => {
		const { dashboard, actions } = setup(24, []);
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: tallSnapshot("zz-last-agent", 80), loading: false });

		const width = 180;
		const height = 24;
		dashboard.handleInput("\t");
		pageOverviewUntil(dashboard, width, height, "filler-12");
		const before = dashboard.render(width, height).map(stripVTControlCharacters);
		const dividerColumn = splitDividerColumn(before);
		const lowerRow = before.findLastIndex(line => line.includes("filler-12"));
		if (lowerRow < 0) throw new Error("Expected a lower agent row in the continuous overview");
		const pointerRow = Math.min(height - 2, lowerRow + 2);

		dashboard.handleInput(mouseEvent(0, dividerColumn - 1, pointerRow));
		const listFocused = dashboard.render(width, height).map(stripVTControlCharacters);
		dashboard.handleInput(mouseEvent(65, dividerColumn - 1, pointerRow));
		expect(dashboard.render(width, height).map(stripVTControlCharacters)).toEqual(listFocused);
		expect(dashboard.selectedSetup).toEqual(CURRENT_SETUP);

		dashboard.handleInput(mouseEvent(0, dividerColumn + 2, pointerRow));
		const overviewFocused = dashboard.render(width, height).map(stripVTControlCharacters);
		dashboard.handleInput(mouseEvent(65, dividerColumn + 2, pointerRow));
		const afterWheel = dashboard.render(width, height).map(stripVTControlCharacters);
		expect(afterWheel).not.toEqual(overviewFocused);
		expect(afterWheel.join("\n")).toContain("Current profile");
		expect(dashboard.selectedSetup).toEqual(CURRENT_SETUP);

		dashboard.handleInput(mouseEvent(64, dividerColumn + 2, pointerRow));
		expect(dashboard.render(width, height).map(stripVTControlCharacters)).toEqual(overviewFocused);
		expect(actions).toEqual([]);
	});

	test("keeps paged setup hit targets aligned through the first and last visible rows after resize", () => {
		const names = Array.from({ length: 24 }, (_, index) => `setup-${String(index + 1).padStart(2, "0")}`);
		names[names.length - 1] = "setup-24-with-an-extremely-long-name-that-stays-inside-the-sidebar";
		const { dashboard, actions } = setup(14, names);
		const setups: ProfileDashboardSetupRef[] = [
			CURRENT_SETUP,
			...names.map((name, index): ProfileDashboardSetupRef =>
				index === names.length - 1
					? {
							kind: "saved",
							name,
							metadata: { version: 1, emoji: "🧪", enabledGroups: [] },
						}
					: savedSetup(name),
			),
		];
		dashboard.setSetups(setups);
		for (const value of setups) dashboard.setSetupState(value, { snapshot: snapshot(), loading: false });

		const width = 140;
		const height = 14;
		const initial = dashboard.render(width, height).map(stripVTControlCharacters);
		const dividerColumn = splitDividerColumn(initial);
		for (let page = 0; page < 4; page++) {
			dashboard.handleInput("\x1b[6~");
			dashboard.render(width, height);
		}

		const setupAt = (lines: readonly string[], name: string) => {
			const needle = name.startsWith("setup-24-") ? "setup-24-" : name;
			for (let row = 0; row < lines.length; row++) {
				const line = lines[row]!;
				let index = line.indexOf(needle);
				while (index >= 0) {
					const column = Bun.stringWidth(line.slice(0, index));
					if (column < dividerColumn) return { row, column, line };
					index = line.indexOf(needle, index + needle.length);
				}
			}
			return undefined;
		};
		const visibleSetups = (lines: readonly string[]) =>
			names
				.map(name => ({ name, position: setupAt(lines, name) }))
				.filter((entry): entry is { name: string; position: { row: number; column: number; line: string } } =>
					Boolean(entry.position),
				)
				.sort((left, right) => left.position.row - right.position.row);
		const clickSetup = (entry: { name: string; position: { row: number; column: number } }) => {
			dashboard.handleInput(mouseEvent(0, entry.position.column, entry.position.row));
			expect(dashboard.selectedSetup).toMatchObject({ kind: "saved", name: entry.name });
			expect(actions.at(-1)).toBe(`select:saved:${entry.name}`);
		};

		let lines = dashboard.render(width, height).map(stripVTControlCharacters);
		let visible = visibleSetups(lines);
		expect(visible.length).toBeGreaterThan(1);
		const first = visible[0]!;
		const last = visible.at(-1)!;
		expect(last.name).toBe(names.at(-1)!);
		const lastDivider = last.position.line.indexOf("│");
		expect(last.position.line.slice(0, lastDivider)).toContain("🧪");
		expect(last.position.line.slice(0, lastDivider)).toContain("setup-24-");
		clickSetup(first);

		lines = dashboard.render(width, height).map(stripVTControlCharacters);
		const lastAfterFirstClick = visibleSetups(lines).at(-1)!;
		expect(lastAfterFirstClick.name).toBe(names.at(-1)!);
		clickSetup(lastAfterFirstClick);

		const compactHeight = 10;
		lines = dashboard.render(width, compactHeight).map(stripVTControlCharacters);
		visible = visibleSetups(lines);
		expect(visible.length).toBeGreaterThan(1);
		clickSetup(visible[0]!);
		lines = dashboard.render(width, compactHeight).map(stripVTControlCharacters);
		const compactLast = visibleSetups(lines).at(-1)!;
		expect(compactLast.name).toBe(names.at(-1)!);
		clickSetup(compactLast);
	});

	test("aligns unequal model rows at wide widths and keeps each role on one row when narrow", () => {
		const profile = snapshot();
		Object.assign(profile.roles[0]!, {
			int: 45.2,
			tps: 82.5,
			contextWindow: 128_000,
			perf: { samples: 12, tps: 118.4, ttftMs: 930 },
		});
		profile.roles.push({
			role: "extraordinarily-long-review-role",
			selector: "google/secondary-model",
			provider: "google",
			modelId: "secondary-model",
			cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
			automatic: false,
			int: 73.6,
			tps: 42,
			contextWindow: 64_000,
			perf: { samples: 9, tps: 42.2, ttftMs: 1_700 },
		});
		profile.warnings = ["Model catalog warning"];

		const wide = setup(48, []);
		wide.dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		const wideLines = wide.dashboard.render(220, 48).map(stripVTControlCharacters);
		const primary = wideLines.find(line => line.includes("fixture-model"));
		const secondary = wideLines.find(line => line.includes("secondary-model"));
		if (!primary || !secondary) throw new Error("Expected both model rows in the wide preview");
		expect(primary.indexOf("45") + "45".length).toBe(secondary.indexOf("74") + "74".length);
		expect(primary.indexOf("0.9s 118t/s") + "0.9s 118t/s".length).toBe(
			secondary.indexOf("1.7s 42t/s") + "1.7s 42t/s".length,
		);
		expect(primary.indexOf("128k") + "128k".length).toBe(secondary.indexOf("64k") + "64k".length);
		expect(primary.indexOf("$3/15") + "$3/15".length).toBe(secondary.indexOf("$2/8") + "$2/8".length);
		expect(wideLines.join("\n")).toContain("Model catalog warning");

		// A narrow pane drops low-priority columns instead of wrapping: each role stays one row.
		const narrow = setup(48, []);
		narrow.dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		const narrowLines = narrow.dashboard.render(80, 48).map(stripVTControlCharacters);
		for (const line of narrowLines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
		const header = narrowLines.findIndex(line => line.includes("Role") && line.includes("Model"));
		expect(header).toBeGreaterThan(0);
		expect(narrowLines[header + 1]).toContain("fixture-model");
		expect(narrowLines[header + 1]).toContain("45");
		expect(narrowLines[header + 2]).toContain("secondary-model");
		expect(narrowLines[header + 2]).toContain("74");
		expect(narrowLines.join("\n")).toContain("Model catalog warning");
	});

	test("shows quota only for the profile's providers, idle ones at 100%, and names who uses each", () => {
		const hour = 3_600_000;
		const report = (provider: string, used: number): UsageReport => ({
			provider,
			fetchedAt: NOW,
			limits: [
				{
					id: "weekly",
					label: "Weekly",
					scope: { provider, windowId: "7d", shared: true },
					window: { id: "7d", label: "7d", durationMs: 168 * hour, resetsAt: NOW + 2 * hour },
					amount: { unit: "percent", usedFraction: used },
				},
			],
		});
		const profile = snapshot();
		profile.roles.push(
			{ role: "web", selector: "web/perplexity", provider: "web", modelId: "perplexity", automatic: false },
			{ role: "smol", selector: "kimi-code/k3", provider: "kimi-code", modelId: "k3", automatic: false },
		);
		const { dashboard } = setup(48, []);
		dashboard.setSetupState(CURRENT_SETUP, {
			snapshot: profile,
			loading: false,
			usage: [report("anthropic", 0.25), report("kimi-code", 0), report("zai", 0.5)],
		});
		const lines = dashboard.render(160, 48).map(stripVTControlCharacters);

		const anthropic = lines.filter(line => line.includes("Anthropic"));
		expect(anthropic).toHaveLength(1);
		expect(anthropic[0]).toContain("Weekly");
		expect(anthropic[0]).toContain("75%");
		expect(anthropic[0]).toContain("default");
		const kimi = lines.filter(line => line.includes("Kimi Code"));
		expect(kimi).toHaveLength(1);
		expect(kimi[0]).toContain("100%");
		expect(kimi[0]).toContain("smol");
		expect(lines.join("\n")).not.toContain("Zai");
		expect(lines.find(line => line.includes("Usage & limits"))).toContain("lowest 75% free");
		expect(lines.find(line => line.includes("Not reported"))).toContain("Web");
		expect(lines.find(line => line.includes("Not reported"))).not.toContain("Anthropic");
	});

	test("consolidates empty roles and identical warnings without losing affected role names", () => {
		const profile = snapshot();
		profile.roles[0]!.warning = "Model selection needs attention";
		profile.roles.push(
			{
				role: "review",
				selector: "google/review-model",
				provider: "google",
				modelId: "review-model",
				automatic: false,
				warning: "Model selection needs attention",
			},
			{ role: "apply", automatic: false },
			{ role: "compact", automatic: false },
		);
		const { dashboard } = setup(48, []);
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		const lines = dashboard.render(180, 48).map(stripVTControlCharacters);
		const warningLines = lines.filter(line => line.includes("Model selection needs attention"));
		expect(warningLines).toHaveLength(1);
		expect(warningLines[0]).toContain("default");
		expect(warningLines[0]).toContain("review");
		const emptyLine = lines.find(line => line.includes("Unassigned"));
		if (!emptyLine) throw new Error("Expected empty model roles to be summarized");
		expect(emptyLine).toContain("apply");
		expect(emptyLine).toContain("compact");
	});

	test("keeps every agent identity, assignment, fallback, and disabled state", () => {
		const { dashboard } = setup(48, []);
		const profile = snapshotWithAgentAssignments();
		profile.agents.push({ name: "inherited-agent", enabled: true, source: "bundled" });
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		dashboard.handleInput("\t");
		const text = pageOverviewUntil(dashboard, 120, 48, "inherited-agent", lines => {
			expect(lines).toHaveLength(48);
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120);
		});
		for (const name of ["scout", "reviewer", "security-reviewer", "task", "sonic", "inherited-agent"]) {
			expect(text).toContain(name);
		}
		for (const assignment of [
			"claude-haiku-4-5",
			"gpt-5.6-sol",
			"missing/security-model",
			"gemini-3-flash",
			"gpt-5.6-mini",
		]) {
			expect(text).toContain(assignment);
		}
		expect(text).toContain("disabled");
		expect(text).toContain("Fallback: default role");
		expect(text).not.toContain("gpt-5.6-sol:high");
	});

	test("summarizes current and saved ownership without leaking the full scalar editor", () => {
		const current = setup(48, []);
		const currentText = current.dashboard.render(180, 48).map(stripVTControlCharacters).join("\n");
		expect(currentText).toMatch(/Settings:[^\n]*current session/);
		expect(currentText).not.toContain("Model options");

		const { dashboard, actions } = setup(48, ["beta"]);
		const configured: ProfileDashboardSetupRef = {
			kind: "saved",
			name: "beta",
			metadata: {
				version: 1,
				emoji: "🧪",
				enabledGroups: ["context", "tasks"],
			},
		};
		const profile = snapshotWithAgentAssignments();
		profile.settings = [
			{
				id: "compaction.enabled",
				label: "Auto-Compact",
				value: false,
				hidden: false,
				configured: false,
			},
			{
				id: "temperature",
				label: "Temperature",
				value: 0,
				hidden: false,
				configured: false,
			},
			{
				id: "topP",
				label: "Top P",
				value: 0.8,
				hidden: false,
				configured: true,
			},
			{
				id: "topK",
				label: "Top K",
				value: 7,
				hidden: false,
				configured: true,
			},
			{
				id: "providers.antigravityEndpoint",
				label: "Antigravity Endpoint Mode",
				value: "sandbox",
				hidden: false,
				configured: true,
			},
			{
				id: "mnemopi.embeddingApiKey",
				label: "Mnemopi Embedding API Key",
				value: "credential-secret",
				hidden: false,
				configured: true,
			},
		];
		dashboard.setSetups([CURRENT_SETUP, configured], configured);
		dashboard.setSetupState(configured, { snapshot: profile, loading: false });
		const setupSelection = ["select:saved:beta"];
		expect(actions).toEqual(setupSelection);
		dashboard.handleInput("\t");

		const summary = pageOverviewUntil(dashboard, 120, 48, "Includes:").replace(/\s+/g, " ");
		expect(summary).toMatch(/Includes: Context, Agents & tasks/);
		expect(summary).toContain("8 groups inherited");
		for (const editorField of [
			"Auto-Compact",
			"Temperature",
			"Top P",
			"Top K",
			"Antigravity Endpoint Mode",
			"Mnemopi Embedding API Key",
			"credential-secret",
		]) {
			expect(summary).not.toContain(editorField);
		}

		expect(actions).toEqual(setupSelection);
		dashboard.handleInput("\r");
		expect(actions).toEqual([...setupSelection, "edit-profile:saved:beta"]);
	});

	test("preserves the unified overview offset across refresh and resets it for another setup", () => {
		const { dashboard, actions } = setup(24, ["beta"]);
		const profile = tallSnapshot();
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		dashboard.handleInput("\t");
		pageOverviewUntil(dashboard, 120, 24, "zz-last-agent");
		const scrolled = dashboard.render(120, 24).map(stripVTControlCharacters);
		expect(scrolled.join("\n")).toContain("Current profile");

		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });
		expect(dashboard.render(120, 24).map(stripVTControlCharacters)).toEqual(scrolled);

		dashboard.handleInput("\t");
		dashboard.handleInput("\x1b[B");
		expect(dashboard.selectedSetup).toEqual(savedSetup("beta"));
		const resetPreview = dashboard.render(120, 24).map(stripVTControlCharacters).join("\n");
		expect(resetPreview).toContain("beta");
		expect(resetPreview).toContain("Models");
		expect(resetPreview).not.toContain("zz-last-agent");
		expect(actions).toEqual(["select:saved:beta"]);
	});

	test("reflows the same reachable overview across narrow and wide resizes", () => {
		const { dashboard, actions } = setup(40, []);
		const profile = snapshotWithAgentAssignments();
		profile.memory = {
			backend: "sqlite",
			scope: "workspace",
			storageLabel: "Profile-local default storage",
		};
		dashboard.setSetupState(CURRENT_SETUP, { snapshot: profile, loading: false });

		const wide = dashboard.render(220, 40).map(stripVTControlCharacters);
		for (const line of wide) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(220);
		const wideModel = wide.find(line => line.includes("fixture-model"));
		if (!wideModel) throw new Error("Expected the overview model row");
		const firstDivider = wideModel.indexOf("│");
		expect(wideModel.slice(firstDivider + 1, wideModel.indexOf("fixture-model"))).not.toContain("│");
		expect(wide.join("\n")).toContain("sqlite (workspace)");

		dashboard.handleInput("\t");
		const narrowOverview = pageOverviewUntil(dashboard, 80, 24, "sonic", lines => {
			expect(lines).toHaveLength(24);
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
			expect(lines.join("\n")).toContain("Current profile");
		});
		for (const value of [
			"Models",
			"fixture-model",
			"Agents",
			"sqlite",
			"workspace",
			"Profile-local default storage",
		]) {
			expect(narrowOverview).toContain(value);
		}

		const resizedWide = dashboard.render(220, 40);
		expect(resizedWide).toHaveLength(40);
		for (const line of resizedWide) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(220);
		moveOverviewToStart(dashboard, 220, 40);
		const reachableAgain = pageOverviewUntil(dashboard, 220, 40, "sonic");
		expect(reachableAgain).toContain("fixture-model");
		expect(reachableAgain).toContain("security-reviewer");
		expect(actions).toEqual([]);
	});

	test("opens the full editor once from either focus and toggles through one overview focus", () => {
		const { dashboard, actions } = setup(40, ["beta"]);
		dashboard.render(120, 40);

		dashboard.handleInput("\r");
		expect(actions.filter(action => action === "edit-profile:current")).toHaveLength(1);
		dashboard.handleInput("\t");
		dashboard.handleInput("\x1b[B");
		expect(dashboard.selectedSetup).toEqual(CURRENT_SETUP);
		dashboard.handleInput("\r");
		expect(actions.filter(action => action === "edit-profile:current")).toHaveLength(2);

		dashboard.handleInput("\t");
		dashboard.handleInput("\x1b[B");
		expect(dashboard.selectedSetup).toEqual(savedSetup("beta"));
		dashboard.handleInput("\r");
		expect(actions.filter(action => action === "edit-profile:saved:beta")).toHaveLength(1);

		dashboard.handleInput("\t");
		dashboard.handleInput("\r");
		expect(actions.filter(action => action === "edit-profile:saved:beta")).toHaveLength(2);
		dashboard.handleInput(" ");
		dashboard.handleInput("e");
		expect(actions.filter(action => action === "edit-profile:saved:beta")).toHaveLength(4);
		dashboard.handleInput("\x1b[Z");
		expect(actions.filter(action => action.startsWith("select:"))).toEqual(["select:saved:beta"]);

		const candidate = setup(24, []);
		candidate.dashboard.render(120, 24);
		candidate.dashboard.handleInput("\t");
		candidate.dashboard.handleInput("\x1b");
		expect(candidate.actions).not.toContain("close");
		candidate.dashboard.handleInput("\x1b");
		expect(candidate.actions.filter(action => action === "close")).toHaveLength(1);
	});

	test("preserves explicit management actions, search boundaries, and refresh errors", () => {
		const narrow = setup(24, ["beta"]);
		narrow.dashboard.handleInput("\x1b[B");
		clickRenderedHint(narrow.dashboard, 80, "l to load");
		clickRenderedHint(narrow.dashboard, 80, "d to delete profile");
		clickRenderedHint(narrow.dashboard, 80, "n to rename profile");
		clickRenderedHint(narrow.dashboard, 80, "e to customize");
		expect(narrow.actions).toEqual(
			expect.arrayContaining(["load:beta", "delete:beta", "rename:beta", "edit-profile:saved:beta"]),
		);

		const narrowLines = narrow.dashboard.render(80).map(stripVTControlCharacters);
		const loadLine = narrowLines.findIndex(line => line.includes("l to load"));
		const loadEnd = narrowLines[loadLine]!.indexOf("l to load") + "l to load".length;
		const separator = narrowLines[loadLine]!.indexOf(" · ", loadEnd);
		if (separator < 0) throw new Error("Expected a wrapped footer separator after the load action");
		const actionCount = narrow.actions.length;
		narrow.dashboard.handleInput(`\x1b[<0;${separator + 2};${loadLine + 1}M`);
		expect(narrow.actions).toHaveLength(actionCount);

		const searchable = setup(24, ["beta", "gamma"]);
		searchable.dashboard.handleInput("/");
		searchable.dashboard.handleInput("gam");
		searchable.dashboard.handleInput("l");
		searchable.dashboard.handleInput("s");
		searchable.dashboard.handleInput("d");
		searchable.dashboard.handleInput("n");
		searchable.dashboard.handleInput("i");
		searchable.dashboard.handleInput("x");
		expect(searchable.actions.some(action => /^(load:|save$|delete:|rename:|import$|export:)/.test(action))).toBe(
			false,
		);
		searchable.dashboard.handleInput("\x1b");
		expect(searchable.actions).not.toContain("close");

		const wide = setup(24, []);
		clickRenderedHint(wide.dashboard, 180, "s to save current");
		clickRenderedHint(wide.dashboard, 180, "i to import profile");
		clickRenderedHint(wide.dashboard, 180, "x to export profile");
		clickRenderedHint(wide.dashboard, 180, "m to choose model");
		clickRenderedHint(wide.dashboard, 180, "a to edit agents");
		clickRenderedHint(wide.dashboard, 180, ", to edit settings");
		expect(wide.actions).toEqual(
			expect.arrayContaining([
				"save",
				"import",
				"export:current",
				"control:model",
				"control:agents",
				"control:settings",
			]),
		);

		const lastGood = snapshot();
		wide.dashboard.setSetupState(CURRENT_SETUP, {
			snapshot: lastGood,
			loading: true,
			refreshError: "Refresh failed\twithout losing preview",
		});
		const refreshed = plain(wide.dashboard, 180);
		expect(refreshed).toContain("fixture-model");
		expect(refreshed).toContain("Refresh failed without losing preview");
		expect(refreshed).toContain("showing cached data");
	});

	test("a filter with no matches leaves the remembered selection inert until it is cleared", () => {
		const { dashboard, actions } = setup(24, ["beta"]);
		dashboard.handleInput("\x1b[B");
		dashboard.handleInput("/");
		dashboard.handleInput("does-not-exist");
		const before = actions.length;

		dashboard.handleInput("\r");
		// Tab would leave search on the hidden setup's preview, where these keys act on it.
		dashboard.handleInput("\t");
		for (const key of ["d", "n", "x", "e", "l"]) dashboard.handleInput(key);
		expect(dashboard.selectedSetup).toBeUndefined();
		expect(plain(dashboard, 120)).not.toContain("beta");
		expect(actions.slice(before)).toEqual([]);

		dashboard.handleInput("\x1b");
		dashboard.handleInput("\r");
		expect(actions.slice(before)).toEqual(["edit-profile:saved:beta"]);
	});
});
