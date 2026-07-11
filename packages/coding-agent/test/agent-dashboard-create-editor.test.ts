import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentDashboard } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import * as discovery from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const tempDirs: string[] = [];

const settingsStub = {
	get: (_key: string) => undefined,
	set: (_key: string, _value: unknown) => {},
	getModelRole: (_role: string) => undefined,
} as unknown as Settings;

async function makeTempCwd(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-dashboard-"));
	tempDirs.push(dir);
	return dir;
}

function typeText(dashboard: AgentDashboard, text: string): void {
	for (const char of text) {
		dashboard.handleInput(char);
	}
}

/**
 * Pin the terminal geometry the dashboard reads via `process.stdout.rows/columns`
 * so the height-fit assertions don't depend on whether the suite runs under a TTY.
 */
function stubStdoutGeometry(cols: number): { setRows(n: number): void; restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	let rows = 24;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
		else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
	};
	return {
		setRows(n: number) {
			rows = n;
		},
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("AgentDashboard create editor", () => {
	test("keeps carriage return as multiline editor text", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\r");
		typeText(dashboard, "second line");
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("> first line");
		expect(rendered).toContain("  second line");
		expect(rendered).toContain("Ctrl+Q/Ctrl+Enter: generate");
		expect(rendered).toContain("Enter: newline");
		expect(rendered).not.toContain("Description is required.");
	});

	test("submits multiline new-agent descriptions on CSI-u Ctrl+Enter", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\r");
		typeText(dashboard, "second line");
		dashboard.handleInput("\x1b[13;5u");
		await Bun.sleep(0);
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("Model registry unavailable in current session.");
		expect(rendered).not.toContain("Description is required.");
	});

	test("keeps bare LF as multiline editor text on non-Windows terminals", async () => {
		if (process.platform === "win32") return;
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\n");
		typeText(dashboard, "second line");
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("> first line");
		expect(rendered).toContain("  second line");
		expect(rendered).toContain("Ctrl+Q/Ctrl+Enter: generate");
		expect(rendered).toContain("Enter: newline");
		expect(rendered).not.toContain("Model registry unavailable in current session.");
		expect(rendered).not.toContain("Description is required.");
	});

	test("submits new-agent descriptions on Ctrl+Q (Windows Terminal fallback for #2118)", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "first line");
		dashboard.handleInput("\r");
		typeText(dashboard, "second line");
		// Ctrl+Q raw byte (0x11). Windows Terminal can't deliver a distinct
		// Ctrl+Enter event, so the app.message.followUp keybinding doubles as a
		// portable submit chord and must apply to the create form too.
		dashboard.handleInput("\x11");
		await Bun.sleep(0);
		const rendered = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(rendered).toContain("Model registry unavailable in current session.");
		expect(rendered).not.toContain("Description is required.");
	});

	test("Ctrl+Q still works after pressing Enter for a newline (Windows Terminal)", async () => {
		await initTheme(false);
		const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 24, {});

		dashboard.handleInput("n");
		typeText(dashboard, "line one");
		// Windows Terminal sends bare `\r` for both Enter and Ctrl+Enter; the
		// dashboard must treat `\r` as a newline so the user can keep typing.
		dashboard.handleInput("\r");
		typeText(dashboard, "line two");
		const beforeSubmit = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");
		expect(beforeSubmit).toContain("> line one");
		expect(beforeSubmit).toContain("  line two");
		expect(beforeSubmit).not.toContain("Model registry unavailable in current session.");

		dashboard.handleInput("\x11");
		await Bun.sleep(0);
		const afterSubmit = dashboard.render(80).join("\n").replace(ANSI_PATTERN, "");

		expect(afterSubmit).toContain("Model registry unavailable in current session.");
	});
});

describe("AgentDashboard layout", () => {
	test("fills the terminal height exactly and keeps the footer visible", async () => {
		await initTheme(false);
		const geo = stubStdoutGeometry(100);
		try {
			geo.setRows(30);
			const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 30, {});
			const lines = dashboard.render(100);
			const plain = lines.map(line => line.replace(ANSI_PATTERN, "")).join("\n");

			// Full-screen overlay must occupy exactly the viewport — never overflow
			// past it (which is what pushed the controls into scrollback).
			expect(lines.length).toBe(30);
			expect(plain).toContain("Agent Control Center");
			expect(plain).toContain("Esc: close");
		} finally {
			geo.restore();
		}
	});

	test("re-fits the body when the terminal height shrinks", async () => {
		await initTheme(false);
		const geo = stubStdoutGeometry(100);
		try {
			geo.setRows(30);
			const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 30, {});
			expect(dashboard.render(100).length).toBe(30);

			geo.setRows(18);
			const shrunk = dashboard.render(100);
			expect(shrunk.length).toBe(18);
			// Footer survives the shrink instead of being clipped off the bottom.
			expect(shrunk.map(line => line.replace(ANSI_PATTERN, "")).join("\n")).toContain("Esc: close");
		} finally {
			geo.restore();
		}
	});
});

describe("AgentDashboard tab navigation", () => {
	test("left/right arrows switch source tabs", async () => {
		await initTheme(false);
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			projectAgentsDir: null,
			agents: [
				{ name: "proj-agent", description: "p", systemPrompt: "", source: "project" },
				{ name: "bundled-agent", description: "b", systemPrompt: "", source: "bundled" },
			],
		});
		const geo = stubStdoutGeometry(120);
		try {
			geo.setRows(30);
			const dashboard = await AgentDashboard.create(await makeTempCwd(), settingsStub, 30, {});
			const strip = () => dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");

			// "All" tab shows every source.
			const all = strip();
			expect(all).toContain("proj-agent");
			expect(all).toContain("bundled-agent");

			// Right arrow advances to the "Project" tab, filtering out bundled agents.
			dashboard.handleInput("\x1b[C");
			const project = strip();
			expect(project).toContain("proj-agent");
			expect(project).not.toContain("bundled-agent");

			// Right again lands on "Bundled".
			dashboard.handleInput("\x1b[C");
			const bundled = strip();
			expect(bundled).toContain("bundled-agent");
			expect(bundled).not.toContain("proj-agent");

			// Left arrow walks back to "Project".
			dashboard.handleInput("\x1b[D");
			const back = strip();
			expect(back).toContain("proj-agent");
			expect(back).not.toContain("bundled-agent");
		} finally {
			geo.restore();
		}
	});
});
