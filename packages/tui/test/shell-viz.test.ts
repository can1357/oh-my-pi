import { describe, expect, it } from "bun:test";
import { RunTrace, Shell, ShellVisualization } from "@oh-my-pi/pi-natives";
import { isShellTrace, type ShellTrace, type ShellVizPresentation } from "@oh-my-pi/pi-wire";
import {
	attachShellTrace,
	decodeShellPresentation,
	defaultShellVizPreferences,
	detachShellTrace,
	readShellPresentation,
	shellVisualization,
} from "../src/tools/shell-viz";
import { renderShellVisualization } from "../src/tools/shell-viz-render";
import { getThemeByName } from "../src/theme";
import { becomesCollectible } from "./gc";

async function runAndAttachSettled(command: string): Promise<{
	settled: ShellTrace;
	liveDefault: ShellVizPresentation;
	liveReplay: ShellVizPresentation;
	liveRef: WeakRef<RunTrace>;
}> {
	const trace = new RunTrace(command);
	await new Shell().run({ command, trace });
	const settled = snapshot(trace);
	attachShellTrace(settled, trace);
	const prefs = defaultShellVizPreferences();
	const replayPrefs = { ...prefs, cursor: settled.history?.length ?? 0 };
	const liveSource = shellVisualization(settled);
	if (!(liveSource instanceof RunTrace)) throw new Error("Expected attached RunTrace");
	return {
		settled,
		liveDefault: readShellPresentation(liveSource, prefs, settled, "sink output\n"),
		liveReplay: readShellPresentation(liveSource, replayPrefs, settled),
		liveRef: new WeakRef(trace),
	};
}

function snapshot(trace: RunTrace): ShellTrace {
	const value: unknown = JSON.parse(trace.snapshot());
	if (!isShellTrace(value)) throw new Error("Expected native execution trace");
	return value;
}
function fixture(): ShellVizPresentation {
	return {
		preferences: { ...defaultShellVizPreferences(), selectedNode: "2:0:17", expandedNodes: ["2:0:17"] },
		rows: [
			{
				id: "command",
				depth: 0,
				node: "2:0:17",
				range: [0, 9],
				state: "ok",
				segments: [{ text: "print(1)", node: "2:0:17", state: "ok", executedAtNs: 4, executionSeq: 8 }],
				effects: [],
				annotations: [{ name: "x", value: "1", node: "2:0:17", setterSeq: 7 }],
			},
		],
		original: [],
		output: "1\n",
		executing: false,
		watches: [{ name: "x", value: "1", node: "2:0:17", setterSeq: 7 }],
		timeline: { length: 8, cursor: 8, elapsedNs: 4, durationNs: 4 },
	};
}

describe("native shell presentation boundary", () => {
	it("rejects malformed DTOs and numeric node identities without compatibility coercion", () => {
		for (const value of [
			{ ...fixture(), rows: [{ ...fixture().rows[0], node: 17 }] },
			{ ...fixture(), rows: [{ ...fixture().rows[0], segments: [{ text: "x", node: "17" }] }] },
			{ ...fixture(), rows: [{ ...fixture().rows[0], segments: [{ text: "x", executionNode: 17 }] }] },
			{ ...fixture(), watches: [{ name: "x", value: "1", node: "2:0:-1" }] },
			{ ...fixture(), preferences: { ...fixture().preferences, expandedNodes: [17] } },
			{ ...fixture(), timeline: { length: 8, cursor: "8", elapsedNs: 4, durationNs: 4 } },
		])
			expect(() => decodeShellPresentation(JSON.stringify(value))).toThrow("invalid visualization presentation");
	});

	it("keeps an unexecuted pending trace uncompiled, including invalid future shell text", () => {
		const trace = new RunTrace("printf first\nif then invalid");
		const before = snapshot(trace);
		readShellPresentation(trace, defaultShellVizPreferences());
		expect(snapshot(trace).units).toEqual([]);
		expect(snapshot(trace).seq).toBe(before.seq);
	});

	it("marks a failed command once, not once per source argument", async () => {
		const command = "false first second\n:";
		const trace = new RunTrace(command);
		const result = await new Shell().run({ command, trace });
		expect(result.exitCode).toBe(0);
		const presentation = readShellPresentation(trace, defaultShellVizPreferences(), snapshot(trace));
		const selectedTheme = await getThemeByName("dark");
		if (!selectedTheme) throw new Error("Missing dark theme");
		const output = Bun.stripANSI(renderShellVisualization(presentation, selectedTheme, 100).join("\n"));
		expect(output.match(/×/g)).toHaveLength(1);
		expect(output).toContain("false first second");
	});

	it("uses the sink only live and replays real captured output from live or stored traces", async () => {
		const command = "printf 'native-boundary\\n'";
		const trace = new RunTrace(command);
		const shell = new Shell();
		await shell.run({ command, trace });
		const live = snapshot(trace);
		attachShellTrace(live, trace);
		const preferences = defaultShellVizPreferences();
		const attached = shellVisualization(live);
		if (!attached) throw new Error("Expected the attached live trace");
		expect(readShellPresentation(attached, preferences, live, "sink notice").output).toBe("sink notice");
		const replay = { ...preferences, cursor: live.history?.length ?? 0 };
		expect(readShellPresentation(trace, replay, live, "sink notice").output).toBe("native-boundary\n");
		const stored = snapshot(trace);
		const restored = shellVisualization(stored);
		if (!restored) throw new Error("Expected the stored trace to restore");
		expect(readShellPresentation(restored, replay, stored).output).toBe("native-boundary\n");
	});

	it("detaches a settled live RunTrace while restoring identical presentation from the snapshot", async () => {
		const { settled, liveDefault, liveReplay, liveRef } = await runAndAttachSettled(
			"count=3\nprintf 'item-%s\\n' \"$count\"\nfalse || printf 'done\\n'",
		);
		detachShellTrace(settled);
		expect(await becomesCollectible(liveRef)).toBe(true);

		const restored = shellVisualization(settled);
		expect(restored).toBeInstanceOf(ShellVisualization);
		if (!restored) throw new Error("Expected restored ShellVisualization");
		expect(shellVisualization(settled)).toBe(restored);
		detachShellTrace(settled);
		expect(shellVisualization(settled)).toBe(restored);

		const prefs = defaultShellVizPreferences();
		const replayPrefs = { ...prefs, cursor: settled.history?.length ?? 0 };
		expect(readShellPresentation(restored, prefs, settled, "sink output\n")).toEqual(liveDefault);
		expect(readShellPresentation(restored, replayPrefs, settled)).toEqual(liveReplay);
	});
});
