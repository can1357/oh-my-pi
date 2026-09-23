import { beforeAll, describe, expect, it } from "bun:test";
import {
	GALLERY_STATES,
	GALLERY_SURFACES,
	parseGalleryStates,
	parseGallerySurfaces,
	renderGalleryState,
	renderGallerySurfaceSections,
	resolveFixture,
} from "@oh-my-pi/pi-coding-agent/cli/gallery-cli";
import {
	type GalleryFixture,
	getComposerGalleryInventory,
	getSegmentGalleryInventory,
} from "@oh-my-pi/pi-coding-agent/cli/gallery-fixtures";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";

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

	it("parses repeatable surfaces and expands all in product order", () => {
		expect(parseGallerySurfaces(["segment", "tool", "segment"])).toEqual(["tool", "segment"]);
		expect(parseGallerySurfaces(["all"])).toEqual([...GALLERY_SURFACES]);
		expect(() => parseGallerySurfaces(["bogus"])).toThrow(/Invalid --surface 'bogus'.*tool.*composer.*segment.*all/);
	});

	it("orders surfaces tool then composer then segment and lets entry filters imply their surface", async () => {
		const composer = getComposerGalleryInventory()[0];
		const segment = getSegmentGalleryInventory()[0];
		if (!composer || !segment) throw new Error("Production gallery registries must not be empty");

		const sections = await renderGallerySurfaceSections({
			surfaces: [...GALLERY_SURFACES],
			tool: "bash",
			composer,
			segment,
			states: ["success"],
		});
		expect(sections.map(section => section.heading)).toEqual([
			"bash — Bash",
			expect.stringContaining(`composer · ${composer}`),
			`segment · ${segment}`,
		]);

		const toolOnly = await renderGallerySurfaceSections({ tool: "bash", states: ["success"] });
		expect(toolOnly.map(section => section.heading)).toEqual(["bash — Bash"]);
		const composerOnly = await renderGallerySurfaceSections({ composer });
		expect(composerOnly).toHaveLength(1);
		expect(composerOnly[0]?.heading).toContain(`composer · ${composer}`);
		const segmentOnly = await renderGallerySurfaceSections({ segment });
		expect(segmentOnly).toHaveLength(1);
		expect(segmentOnly[0]?.heading).toBe(`segment · ${segment}`);
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
		const cases = [["wait", "Subagent exited 1: Redis connection string is missing.", "42 pass"]] as const;

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

	it("renders URL coordination receipts, cancellation and process errors without file-write chrome", async () => {
		const render = async (name: string, state: "streaming" | "success" | "error") =>
			Bun.stripANSI((await renderGalleryState(name, resolveFixture(name), state, 100)).join("\n"));
		expect(await render("write_agent", "success")).toContain("IRC");
		expect(await render("write_agent", "success")).toContain("injected");
		const broadcast = await render("write_agent_broadcast", "success");
		expect(broadcast).toContain("2 delivered");
		expect(broadcast).toContain("1 failed");
		expect(broadcast).toContain("not running");
		const failedReceipt = await render("write_agent_failed_receipt", "success");
		expect(failedReceipt).toContain("failed");
		expect(failedReceipt).toContain("not running");
		const cancel = await render("write_proc_cancel", "success");
		expect(cancel).toContain("Proc cancel build-42");
		expect(cancel).toContain("Build assets");
		expect(cancel).toContain("cancelled");
		const error = await render("write_agent", "error");
		expect(error).toContain("IRC");
		expect(error).toContain("Peer messaging is unavailable");
		expect(error).not.toContain("Write");
		const procError = await render("read_proc_job", "error");
		expect(procError).toContain("Proc build-42");
		expect(procError).not.toContain("Read proc://");
	});

	it("defers write path prefixes until the streamed URL target settles", () => {
		const options = { expanded: false, isPartial: true };
		expect(writeToolRenderer.renderCall({ path: "ag" }, options, theme)).toBeUndefined();
		expect(writeToolRenderer.renderCall({ path: "agent://Reviewer" }, options, theme)).toBeUndefined();
		expect(writeToolRenderer.renderCall({ path: "pro" }, options, theme)).toBeUndefined();
		expect(writeToolRenderer.renderCall({ path: "proc://build-42", content: "" }, options, theme)).toBeDefined();
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
