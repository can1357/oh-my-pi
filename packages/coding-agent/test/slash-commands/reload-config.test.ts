import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Effort } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgDefaultThinkingLevel, cfgHideThinkingBlock } from "@oh-my-pi/pi-coding-agent/session/settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

function createRuntime(settings: Settings) {
	const output: string[] = [];
	const session = { settings };
	const emit = (text: string) => {
		output.push(text);
	};
	const setText = vi.fn();
	const ctx = {
		session,
		settings,
		editor: { setText },
		showStatus: emit,
	} as unknown as InteractiveModeContext;
	const runtime = { session, settings, output: emit } as unknown as SlashCommandRuntime;
	return { output, runtime, ctx, setText };
}

describe("/reload-config", () => {
	let tempDir: TempDir;
	let configPath: string;
	let settings: Settings | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-reload-config-");
		configPath = tempDir.join("agent", "config.yml");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await settings?.flush();
		} finally {
			settings?.cancelPendingSaves();
			settings = undefined;
			await tempDir.remove();
		}
	});

	async function openSettings(raw: Record<string, unknown>): Promise<Settings> {
		await Bun.write(configPath, YAML.stringify(raw));
		settings = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir: tempDir.join("agent") });
		return settings;
	}

	it("reloads an edited file into the TUI's retained settings and names the changed key", async () => {
		const retained = await openSettings({ defaultThinkingLevel: "low" });
		const harness = createRuntime(retained);
		await Bun.write(configPath, YAML.stringify({ defaultThinkingLevel: "high" }));

		const handled = await executeBuiltinSlashCommand("/reload-config", { ctx: harness.ctx });

		expect(handled).toBe(true);
		expect(cfgDefaultThinkingLevel.get(retained)).toBe(Effort.High);
		expect(harness.output[0]).toContain("1 setting changed");
		expect(harness.output[0]).toContain("defaultThinkingLevel");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("reports multiple effective changes through the text command handler", async () => {
		const retained = await openSettings({ defaultThinkingLevel: "low", hideThinkingBlock: false });
		const harness = createRuntime(retained);
		await Bun.write(configPath, YAML.stringify({ defaultThinkingLevel: "high", hideThinkingBlock: true }));

		const result = await executeAcpBuiltinSlashCommand("/reload-config", harness.runtime);

		expect(result).toEqual({ consumed: true });
		expect(cfgDefaultThinkingLevel.get(retained)).toBe(Effort.High);
		expect(cfgHideThinkingBlock.get(retained)).toBe(true);
		expect(harness.output[0]).toContain("2 settings changed");
		expect(harness.output[0]).toContain("defaultThinkingLevel");
		expect(harness.output[0]).toContain("hideThinkingBlock");
	});

	it("does not report disk edits hidden by a runtime override as effective changes", async () => {
		const retained = await openSettings({ defaultThinkingLevel: "low" });
		cfgDefaultThinkingLevel.override(retained, Effort.High);
		const harness = createRuntime(retained);
		await Bun.write(configPath, YAML.stringify({ defaultThinkingLevel: "medium" }));

		await executeAcpBuiltinSlashCommand("/reload-config", harness.runtime);

		expect(cfgDefaultThinkingLevel.get(retained)).toBe(Effort.High);
		expect(harness.output[0]).toContain("nothing to apply");
		expect(harness.output[0]).not.toContain("setting changed");
	});

	it("reports malformed YAML safely while retaining the last valid settings", async () => {
		const retained = await openSettings({ defaultThinkingLevel: "high", hideThinkingBlock: true });
		const harness = createRuntime(retained);
		await Bun.write(configPath, `defaultThinkingLevel: [unclosed\t${"x".repeat(TRUNCATE_LENGTHS.LINE * 2)}\n`);
		vi.spyOn(os, "homedir").mockReturnValue(tempDir.path());

		const result = await executeAcpBuiltinSlashCommand("/reload-config", harness.runtime);

		expect(result).toEqual({ consumed: true });
		expect(cfgDefaultThinkingLevel.get(retained)).toBe(Effort.High);
		expect(cfgHideThinkingBlock.get(retained)).toBe(true);
		const error = harness.output[0]!;
		expect(error).toContain("Config reload failed");
		expect(error).toContain("previous settings kept");
		expect(error).toContain("invalid");
		expect(error).toContain("~/agent/config.yml");
		expect(error).not.toContain(tempDir.path());
		expect(error).not.toMatch(/[\t\r\n\x1b]/);
		expect(Bun.stringWidth(error)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
	});
});
