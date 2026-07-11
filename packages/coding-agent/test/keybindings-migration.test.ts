import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@pk-nerdsaver-ai/pi-coding-agent/config/keybindings";
import { matchesAppFollowUp } from "@pk-nerdsaver-ai/pi-coding-agent/modes/utils/keybinding-matchers";
import { setKeybindings } from "@pk-nerdsaver-ai/pi-tui";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { YAML } from "bun";

function ctrl(key: string): string {
	return String.fromCharCode(key.toLowerCase().charCodeAt(0) & 31);
}
describe("KeybindingsManager.create", () => {
	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("migrates legacy keybinding JSON to YAML during create", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const jsonPath = path.join(agentDir, "keybindings.json");
		const ymlPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			jsonPath,
			`${JSON.stringify(
				{
					fork: "ctrl+f",
					selectConfirm: "enter",
					cursorUp: "ctrl+p",
					selectModelTemporary: "alt+y",
				},
				null,
				2,
			)}\n`,
		);

		try {
			const manager = KeybindingsManager.create(agentDir);
			const writtenConfig = YAML.parse(await Bun.file(ymlPath).text());

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.select.confirm")).toEqual(["enter"]);
			expect(manager.getKeys("tui.editor.cursorUp")).toEqual(["ctrl+p"]);
			expect(manager.getKeys("app.model.selectTemporary")).toEqual(["alt+y"]);
			expect(writtenConfig).toEqual({
				"app.model.selectTemporary": "alt+y",
				"app.session.fork": "ctrl+f",
				"tui.editor.cursorUp": "ctrl+p",
				"tui.select.confirm": "enter",
			});
			expect(writtenConfig).not.toHaveProperty("selectModelTemporary");
			expect(await Bun.file(jsonPath).exists()).toBe(true);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("migrates legacy keybinding JSON with comments to YAML during create", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const jsonPath = path.join(agentDir, "keybindings.json");
		const ymlPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			jsonPath,
			`{
	// Legacy config files may contain comments from hand-edited examples.
	"fork": "ctrl+f",
	"selectConfirm": "enter",
	"cursorUp": "ctrl+p",
	"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"]
}
`,
		);

		try {
			const manager = KeybindingsManager.create(agentDir);
			const writtenConfig = YAML.parse(await Bun.file(ymlPath).text());

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("tui.select.confirm")).toEqual(["enter"]);
			expect(manager.getKeys("tui.editor.cursorUp")).toEqual(["ctrl+p"]);
			expect(manager.getKeys("app.clipboard.copyPrompt")).toEqual(["alt+c", "ctrl+shift+c"]);
			expect(writtenConfig).toEqual({
				"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"],
				"app.session.fork": "ctrl+f",
				"tui.editor.cursorUp": "ctrl+p",
				"tui.select.confirm": "enter",
			});
			expect(await Bun.file(jsonPath).exists()).toBe(true);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("loads keybindings.yml directly", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const configPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			configPath,
			YAML.stringify(
				{
					"app.session.fork": "ctrl+f",
					"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"],
				},
				null,
				2,
			),
		);

		try {
			const manager = KeybindingsManager.create(agentDir);

			expect(manager.getKeys("app.session.fork")).toEqual(["ctrl+f"]);
			expect(manager.getKeys("app.clipboard.copyPrompt")).toEqual(["alt+c", "ctrl+shift+c"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("accepts keybindings.yaml when present", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));
		const yamlPath = path.join(agentDir, "keybindings.yaml");
		const canonicalPath = path.join(agentDir, "keybindings.yml");

		await Bun.write(
			yamlPath,
			YAML.stringify(
				{
					"app.plan.toggle": "alt+shift+p",
				},
				null,
				2,
			),
		);

		try {
			const manager = KeybindingsManager.create(agentDir);

			expect(manager.getKeys("app.plan.toggle")).toEqual(["alt+shift+p"]);
			expect(await Bun.file(canonicalPath).exists()).toBe(false);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("defaults model selection to Alt+M and display reset to Ctrl+L", () => {
		const manager = KeybindingsManager.inMemory();

		expect(manager.getKeys("app.model.select")).toEqual(["alt+m"]);
		expect(manager.getKeys("app.display.reset")).toEqual(["ctrl+l"]);
	});

	it("keeps the Ctrl+L display reset default when an old model remap still claims Ctrl+L", () => {
		const manager = KeybindingsManager.inMemory({
			"app.model.select": "ctrl+l",
		});

		expect(manager.getKeys("app.model.select")).toEqual(["ctrl+l"]);
		expect(manager.getKeys("app.display.reset")).toEqual(["ctrl+l"]);
		expect(manager.getEffectiveConfig()["app.display.reset"]).toBe("ctrl+l");
	});

	it("keeps Ctrl+L when the user explicitly assigns it to display reset", () => {
		const manager = KeybindingsManager.inMemory({
			"app.display.reset": "ctrl+l",
		});

		expect(manager.getKeys("app.display.reset")).toEqual(["ctrl+l"]);
	});

	it("defaults the follow-up shortcut to both Ctrl+Q and Ctrl+Enter (#1903)", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-keybindings-"));

		try {
			const manager = KeybindingsManager.create(agentDir);

			// Both chords must be registered so Windows Terminal users (which swallow
			// Ctrl+Enter at the terminal layer) get a working follow-up binding out
			// of the box, without breaking users on Kitty/iTerm2/WezTerm/Ghostty.
			expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q", "ctrl+enter"]);
		} finally {
			await removeWithRetries(agentDir);
		}
	});

	it("removes the Ctrl+Q follow-up default when a user remap already claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"app.plan.toggle": "ctrl+q",
		});
		setKeybindings(manager);

		expect(manager.getKeys("app.plan.toggle")).toEqual(["ctrl+q"]);
		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+enter"]);
		expect(manager.getDisplayString("app.message.followUp")).toBe("Ctrl+Enter");
		expect(manager.getEffectiveConfig()["app.message.followUp"]).toBe("ctrl+enter");
		expect(matchesAppFollowUp(ctrl("q"))).toBe(false);
		expect(matchesAppFollowUp("\x1b[13;5u")).toBe(true);
	});

	it("keeps the Ctrl+Q follow-up default when only an unknown config key claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"unknown.action": "ctrl+q",
		});

		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q", "ctrl+enter"]);
	});

	it("keeps Ctrl+Q when the user explicitly assigns it to follow-up (#1903)", () => {
		const manager = KeybindingsManager.inMemory({
			"app.message.followUp": "ctrl+q",
		});

		expect(manager.getKeys("app.message.followUp")).toEqual(["ctrl+q"]);
	});
});
