/**
 * Status-line segments under pressure: the session name's accent follows the
 * `sessionAccent` setting, the path segment shrinks with its `maxLength`
 * option, and a bar too narrow for every segment drops the model before the
 * working directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import { effectiveStatusSettings, segmentView } from "@oh-my-pi/pi-coding-agent/ui/status/segments";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { segmentText, statusFacts, statusText } from "./helpers/session-status-line";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

describe("status line session accent", () => {
	/** Theme tokens the session-name segment paints its text with. */
	function nameTokens(sessionAccent: boolean): string[] {
		const view = segmentView(
			"session_name",
			statusFacts({ sessionName: "Named session" }),
			effectiveStatusSettings({ preset: "custom", sessionAccent }),
		);
		return (view?.look.pieces ?? []).flatMap(piece => ("t" in piece && piece.s ? [piece.s] : []));
	}

	it("paints the session name with the hash-derived session accent when enabled", () => {
		expect(nameTokens(true)).toContain("sessionAccent");
	});

	it("paints the session name with the theme accent when disabled", () => {
		const tokens = nameTokens(false);
		expect(tokens).toContain("accent");
		expect(tokens).not.toContain("sessionAccent");
	});
});

describe("path segment truncation at varying maxLength", () => {
	const cwd = "/home/user/omp-overflow-very-long-directory-name-for-testing-abcdef/nested/leaf";
	const pathText = (maxLength: number) =>
		segmentText("path", statusFacts({ cwd, home: "/home/user" }), {
			preset: "custom",
			segmentOptions: {
				path: { maxLength, abbreviate: false, stripWorkPrefix: false },
			},
		}) ?? "";

	it("truncates path with ellipsis when maxLength is smaller than path", () => {
		expect(visibleWidth(pathText(10))).toBeLessThan(visibleWidth(pathText(200)));
		expect(pathText(10)).toContain("…");
	});

	it("reduces visible width monotonically as maxLength decreases", () => {
		const widths = [40, 20, 10, 4].map(maxLength => visibleWidth(pathText(maxLength)));
		for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]!);
	});

	it("still renders a visible segment at maxLength=4", () => {
		expect(visibleWidth(pathText(4))).toBeGreaterThan(0);
	});
});

describe("overflow: path survives before model", () => {
	it("drops the model segment before the cwd path when both cannot fit", () => {
		const settings: StatusLineSettings = {
			preset: "custom",
			leftSegments: ["pi", "model", "path"],
			rightSegments: [],
			separator: "none",
			sessionAccent: false,
			transparent: true,
			segmentOptions: {
				model: { showThinkingLevel: false },
				path: { abbreviate: false, maxLength: 32, stripWorkPrefix: false },
			},
		};
		const modelName = `MODEL_SHOULD_DROP_${"x".repeat(24)}`;
		const facts = statusFacts({
			model: { id: modelName, name: modelName, thinking: false },
			cwd: "/tmp/root/cwdxyz",
			home: "/home/user",
		});

		expect(statusText(settings, facts, 160)).toContain(modelName);
		const narrow = statusText(settings, facts, 40);
		expect(narrow).toContain("xyz");
		expect(narrow).not.toContain("MODEL_SHOULD_DROP");
	});
});
