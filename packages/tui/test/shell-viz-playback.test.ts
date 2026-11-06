import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { RunTrace, Shell } from "@oh-my-pi/pi-natives";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { isShellTrace, type ShellTrace, type ShellVizPresentation } from "@oh-my-pi/pi-wire";

const context: DescribeContext = {
	cols: 100,
	dark: true,
	reduceMotion: true,
	supports: () => true,
	feature: () => false,
};
const components: ToolExecutionComponent[] = [];
let nativeTrace: ShellTrace;

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Missing dark theme");
	setThemeInstance(theme);
	const command = "printf 'done\\n'";
	const trace = new RunTrace(command);
	await new Shell().run({ command, trace });
	const value: unknown = JSON.parse(trace.snapshot());
	if (!isShellTrace(value)) throw new Error("Expected canonical native trace");
	nativeTrace = value;
});
afterEach(() => {
	for (const component of components.splice(0)) component.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function findPresentation(node: NativeNode): ShellVizPresentation | undefined {
	if (node.k === "shell") return node.p?.presentation;
	for (const child of node.c ?? []) {
		const described = "k" in child ? child : child.describe?.(context);
		if (described) {
			const found = findPresentation(described);
			if (found) return found;
		}
	}
	return undefined;
}

function presentation(component: ToolExecutionComponent): ShellVizPresentation {
	const value = findPresentation(component.describe(context));
	if (!value) throw new Error("Expected a native shell presentation");
	return value;
}

function tool(trace: ShellTrace, pending = false): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"bash",
		{ command: trace.script },
		{ useBuiltInRenderer: true, showImages: false },
		undefined,
		{
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		},
	);
	components.push(component);
	if (!pending)
		component.updateResult({ content: [{ type: "text", text: "final output" }], details: { trace } }, false);
	return component;
}

/** Stretch actual canonical events to a deterministic UI playback clock. */
function completedTrace(output = "done\n"): ShellTrace {
	const events = nativeTrace.history ?? [];
	const runStart = events.find(event => event.kind === "RunStart");
	const commandStart = events.find(event => event.kind === "CmdStart");
	const commandEnd = events.find(event => event.kind === "CmdEnd");
	const captured = events.find(event => event.kind === "Output");
	const runEnd = events.find(event => event.kind === "RunEnd");
	if (!runStart || !commandStart || !commandEnd || !captured || !runEnd)
		throw new Error("Expected real native command lifecycle and output");
	return {
		...nativeTrace,
		seq: 5,
		t_ns: 10_000_000_000,
		history: [
			{ ...runStart, seq: 1, t_ns: 0 },
			{ ...commandStart, seq: 2, t_ns: 0 },
			{ ...captured, seq: 3, t_ns: 10_000_000_000, text: output },
			{ ...commandEnd, seq: 4, t_ns: 10_000_000_000, dur_ns: 10_000_000_000 },
			{ ...runEnd, seq: 5, t_ns: 10_000_000_000 },
		],
	};
}

function fakeClock(): (milliseconds: number) => void {
	vi.useFakeTimers({ now: 0 });
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	return milliseconds => {
		now += milliseconds;
		vi.advanceTimersByTime(milliseconds);
	};
}

describe("bash visualization playback", () => {
	it("shows plain commands and output when visualization is disabled, including saved traces", () => {
		setChatTranscriptDisplayPreferences({ shellVisualization: false });
		try {
			const trace = completedTrace();
			const pending = tool(trace, true);
			expect(findPresentation(pending.describe(context))).toBeUndefined();
			expect(Bun.stripANSI(pending.render(100).join("\n"))).toContain("printf");

			const component = tool(trace);
			expect(findPresentation(component.describe(context))).toBeUndefined();
			const rendered = Bun.stripANSI(component.render(100).join("\n"));
			expect(rendered).toContain("printf");
			expect(rendered).toContain("final output");

			setChatTranscriptDisplayPreferences({ shellVisualization: true });
			pending.invalidate();
			component.invalidate();
			expect(findPresentation(pending.describe(context))).toBeDefined();
			expect(findPresentation(component.describe(context))).toBeDefined();
		} finally {
			setChatTranscriptDisplayPreferences({ shellVisualization: true });
		}
	});

	it("resumes the remaining part of a paused event gap instead of restarting it", () => {
		const advance = fakeClock();
		const component = tool(completedTrace());
		component.shellVizAction("play");
		advance(8_000);
		expect(presentation(component).output).toBe("");
		expect(presentation(component).running).toBe(true);
		component.shellVizAction("pause");
		advance(1_000);
		component.shellVizAction("play");
		advance(2_000);
		expect(presentation(component).output).toBe("done\n");
		expect(presentation(component).preferences.playing).toBe(false);
	});

	it("starts trimmed playback at the first retained timestamp, not the original run origin", () => {
		const advance = fakeClock();
		const trace = completedTrace();
		trace.historyTruncated = true;
		trace.t_ns = 301_000_000_000;
		const output = trace.history?.find(event => event.kind === "Output");
		const end = trace.history?.find(event => event.kind === "RunEnd");
		if (!output || !end) throw new Error("Expected native output and completion");
		trace.history = [
			{ ...output, seq: 101, t_ns: 300_000_000_000, text: "retained\n" },
			{ ...end, seq: 102, t_ns: 301_000_000_000 },
		];
		const component = tool(trace);
		component.shellVizAction("reset");
		component.shellVizAction("play");
		advance(80);
		expect(presentation(component).output).toBe("retained\n");
		expect(presentation(component).timeline.cursor).toBe(1);
	});

	it("strips unsafe terminal controls from replay rendering without mutating retained bytes", () => {
		const unsafe = "safe\x1b[2J\x1b]52;c;YWJj\x07tail\n";
		const trace = completedTrace(unsafe);
		const component = tool(trace);
		component.shellVizAction("seek:3");
		const rendered = component.render(100).join("\n");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toContain("\x1b]52");
		expect(Bun.stripANSI(rendered)).toContain("safetail");
		expect(trace.history?.[2]?.text).toBe(unsafe);
	});
});
