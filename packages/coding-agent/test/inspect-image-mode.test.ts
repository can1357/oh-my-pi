/**
 * Regression tests for the inspect_image tri-state mode (`inspect_image.mode`),
 * the `/vision` session override precedence, and the legacy
 * `inspect_image.enabled` → `inspect_image.mode` migration.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools/index";
import { ReadTool } from "../src/tools/read";
import { isInspectImageToolActive } from "../src/utils/inspect-image-mode";

const visionModel = { provider: "kimi-code", id: "k3", input: ["text", "image"] } as unknown as Model;
const textModel = { provider: "openai", id: "gpt-x", input: ["text"] } as unknown as Model;

function activeFor(
	overrides: Record<string, unknown>,
	model: Model | undefined,
	sessionOverride?: "on" | "off",
): boolean {
	const settings = Settings.isolated(overrides);
	return isInspectImageToolActive({
		settings,
		getActiveModel: () => model,
		getInspectImageModeOverride: () => sessionOverride,
	});
}

describe("isInspectImageToolActive", () => {
	test("auto hides the tool for image-capable models", () => {
		expect(activeFor({}, visionModel)).toBe(false);
	});

	test("auto exposes the tool for text-only models", () => {
		expect(activeFor({}, textModel)).toBe(true);
	});

	test("auto treats an unresolved model as text-only", () => {
		expect(activeFor({}, undefined)).toBe(true);
	});

	test("on forces the tool even for image-capable models", () => {
		expect(activeFor({ "inspect_image.mode": "on" }, visionModel)).toBe(true);
	});

	test("off suppresses the tool even for text-only models", () => {
		expect(activeFor({ "inspect_image.mode": "off" }, textModel)).toBe(false);
	});

	test("session override wins over the persisted setting", () => {
		expect(activeFor({}, visionModel, "on")).toBe(true);
		expect(activeFor({ "inspect_image.mode": "on" }, visionModel, "off")).toBe(false);
	});
});

describe("inspect_image.enabled migration", () => {
	test("nested enabled=true migrates to mode on", () => {
		const settings = Settings.isolated({ "inspect_image.enabled": true });
		expect(settings.get("inspect_image.mode")).toBe("on");
	});

	test("nested enabled=false migrates to mode off", () => {
		const settings = Settings.isolated({ "inspect_image.enabled": false });
		expect(settings.get("inspect_image.mode")).toBe("off");
	});

	test("explicit mode wins over a stale legacy key", () => {
		const settings = Settings.isolated({ "inspect_image.enabled": true, "inspect_image.mode": "off" });
		expect(settings.get("inspect_image.mode")).toBe("off");
	});

	describe("flat dotted key in config.yml", () => {
		let agentDir: string;
		afterEach(() => {
			if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
		});

		test("flat inspect_image.enabled migrates to mode", async () => {
			agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vision-migration-"));
			fs.writeFileSync(path.join(agentDir, "config.yml"), '"inspect_image.enabled": true\n');
			const settings = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
			expect(settings.get("inspect_image.mode")).toBe("on");
		});

		test("nested inspect_image.enabled in config.yml migrates to mode", async () => {
			agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vision-migration-"));
			fs.writeFileSync(path.join(agentDir, "config.yml"), "inspect_image:\n  enabled: false\n");
			const settings = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
			expect(settings.get("inspect_image.mode")).toBe("off");
		});

		test("flat explicit mode survives alongside a flat legacy key", async () => {
			agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-vision-migration-"));
			fs.writeFileSync(
				path.join(agentDir, "config.yml"),
				'"inspect_image.enabled": true\n"inspect_image.mode": "off"\n',
			);
			const settings = await Settings.loadReadOnly({ agentDir, cwd: agentDir });
			expect(settings.get("inspect_image.mode")).toBe("off");
		});
	});
});

describe("read tool follows actual tool availability", () => {
	function readSession(options: {
		inspectImageActive: boolean;
		xdevMounted?: boolean;
		settings?: Record<string, unknown>;
	}): ToolSession {
		return {
			cwd: os.tmpdir(),
			hasUI: false,
			settings: Settings.isolated(options.settings ?? {}),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getActiveModel: () => textModel,
			isToolActive: (name: string) => name === "inspect_image" && options.inspectImageActive,
			...(options.xdevMounted === undefined
				? {}
				: {
						xdev: {
							tools: new Map(),
							mountedNames: new Set(options.xdevMounted ? ["inspect_image"] : []),
							builtInNames: new Set(["inspect_image"]),
							isActive: () => false,
						},
					}),
		} as unknown as ToolSession;
	}

	test("restricted session (tool absent) never advertises inspect_image", () => {
		// auto mode + text-only model would compute active=true, but the tool is
		// not in this session's slate, so read must serve inline image blocks.
		const tool = new ReadTool(readSession({ inspectImageActive: false }));
		expect(tool.description).not.toContain("call `inspect_image`");
		expect(tool.syncInspectImageState()).toBe(false);
	});

	test("session with the tool registered advertises it", () => {
		const tool = new ReadTool(readSession({ inspectImageActive: true }));
		expect(tool.syncInspectImageState()).toBe(true);
	});

	test("xd://-mounted inspect_image counts as available", () => {
		// Default sessions mount discoverable built-ins under xd://, removing them
		// from the top-level predicate while they stay executable via
		// `write xd://inspect_image` — read must keep pointing at the tool.
		const tool = new ReadTool(readSession({ inspectImageActive: false, xdevMounted: true }));
		expect(tool.syncInspectImageState()).toBe(true);
		expect(tool.description).toContain("call `inspect_image`");
	});

	test("mode off wins over a lingering xd:// mount", () => {
		// Built-in devices are never reconciled out of the xdev registry, so after
		// `/vision off` the device still resolves — the effective mode must gate it.
		const tool = new ReadTool(
			readSession({
				inspectImageActive: false,
				xdevMounted: true,
				settings: { "inspect_image.mode": "off" },
			}),
		);
		expect(tool.syncInspectImageState()).toBe(false);
		expect(tool.description).not.toContain("call `inspect_image`");
	});
});
