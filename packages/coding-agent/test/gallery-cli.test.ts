import { beforeAll, describe, expect, it } from "bun:test";
import {
	GALLERY_STATES,
	parseGalleryStates,
	renderGalleryState,
	resolveFixture,
} from "@pk-nerdsaver-ai/pi-coding-agent/cli/gallery-cli";
import type { GalleryFixture } from "@pk-nerdsaver-ai/pi-coding-agent/cli/gallery-fixtures";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { initTheme, theme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { toolRenderers } from "@pk-nerdsaver-ai/pi-coding-agent/tools/renderers";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false, undefined, undefined, "dark", "light");
});

describe("gallery harness", () => {
	it("accepts displayed gallery state labels and legacy tokens", () => {
		expect(parseGalleryStates(["streaming args", "in progress", "done", "failed"])).toEqual([
			"streaming",
			"progress",
			"success",
			"error",
		]);
		expect(parseGalleryStates(["streaming", "progress", "success", "error", "failed"])).toEqual([...GALLERY_STATES]);
	});

	it("rejects unknown gallery state tokens before rendering", () => {
		expect(() => parseGalleryStates(["bogus"])).toThrow(
			/Invalid --state 'bogus'.*streaming args.*in progress.*done.*failed/,
		);
	});

	it("renders every registered tool in every lifecycle state without throwing", async () => {
		for (const name in toolRenderers) {
			const fixture = resolveFixture(name);
			for (const state of GALLERY_STATES) {
				const lines = await renderGalleryState(name, fixture, state, 100);
				// A renderer that produces no lines for a state is a regression: the
				// component should always emit at least the call header or result.
				expect(lines.length, `${name}/${state} rendered nothing`).toBeGreaterThan(0);
			}
		}
	});

	it("routes each state to the matching args/result (streaming args vs result, success vs error)", async () => {
		const fixture: GalleryFixture = {
			label: "Bash",
			streamingArgs: { command: "echo STREAM_MARK" },
			args: { command: "echo PROGRESS_MARK" },
			result: { content: [{ type: "text", text: "SUCCESS_OUT" }], details: { exitCode: 0 } },
			errorResult: { content: [{ type: "text", text: "ERROR_OUT" }], isError: true, details: { exitCode: 1 } },
		};
		const render = async (state: (typeof GALLERY_STATES)[number]) =>
			Bun.stripANSI((await renderGalleryState("bash", fixture, state, 100)).join("\n"));

		const streaming = await render("streaming");
		expect(streaming).toContain("STREAM_MARK");
		expect(streaming).not.toContain("PROGRESS_MARK");
		expect(streaming).not.toContain("SUCCESS_OUT");

		const progress = await render("progress");
		expect(progress).toContain("PROGRESS_MARK");
		expect(progress).not.toContain("SUCCESS_OUT");

		const success = await render("success");
		expect(success).toContain("SUCCESS_OUT");
		expect(success).not.toContain("ERROR_OUT");

		const error = await render("error");
		expect(error).toContain("ERROR_OUT");
		expect(error).not.toContain("SUCCESS_OUT");
	});

	it("routes customRendered tools (task) through the custom-tool branch", async () => {
		// `task` attaches its renderer on the real AgentTool, so the gallery must
		// reproduce that path. With a result present and mergeCallAndResult, the
		// custom branch must NOT emit a redundant tool-name line above the result box
		// (regression guard for tool-execution's custom-branch fallback label).
		const task = resolveFixture("task");
		expect(task.customRendered).toBe(true);
		const lines = await renderGalleryState("task", task, "error", 100);
		const stripped = lines.map(line => Bun.stripANSI(line).trim());
		// The framed result header carries the label inside the box border...
		expect(stripped.some(line => line.startsWith(theme.boxRound.topLeft) && line.includes("Task"))).toBe(true);
		// ...but no standalone "Task" label line precedes it.
		expect(stripped).not.toContain("Task");
	});

	it("renders curated failed states as failures", async () => {
		const cases = [
			["irc_inbox", "IRC inbox failed: message store unavailable.", "IRC inbox empty"],
			["irc_list", "IRC list failed: agent hub is unavailable.", "no other agents"],
			["job", "Subagent exited 1: Redis connection string is missing.", "cancelled"],
		] as const;

		for (const [name, expected, forbidden] of cases) {
			const output = Bun.stripANSI((await renderGalleryState(name, resolveFixture(name), "error", 100)).join("\n"));
			expect(output).toContain(expected);
			expect(output).not.toContain(forbidden);
		}
	});

	it("renders gallery-only read group fixtures", async () => {
		const fixture = resolveFixture("read_group");
		const success = Bun.stripANSI((await renderGalleryState("read_group", fixture, "success", 140)).join("\n"));
		const renderPathMatches = success.match(/packages\/coding-agent\/src\/task\/render\.ts/g) ?? [];

		expect(success).toContain("Read (4)");
		expect(renderPathMatches).toHaveLength(1);
		expect(success).toContain("packages/coding-agent/src/task/render.ts:507-605,1070-1194,…,1270-1274");
		expect(success).not.toContain("1210-1240");
		expect(success).not.toContain("full file");
	});

	it("falls back to a generic fixture for registry tools without curated sample data", () => {
		// resolveFixture never returns undefined for a registry tool, even one
		// missing from the curated fixtures, so the gallery cannot crash on a newly
		// added renderer.
		const fixture = resolveFixture("a-tool-that-has-no-fixture");
		expect(fixture.args).toBeDefined();
		expect(fixture.result.content.length).toBeGreaterThan(0);
	});
});
