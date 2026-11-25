import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultPasteImageKeys } from "@oh-my-pi/pi-coding-agent/config/keybindings/app-keybindings";
import type { KeybindingsConfig } from "@oh-my-pi/pi-coding-agent/config/keybindings/config-file";
import { canonicalKeyId, type KeyId } from "@oh-my-pi/pi-coding-agent/config/keybindings/key-id";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
} from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { appFollowUpKeys, matchesAnyKey } from "@oh-my-pi/pi-coding-agent/config/keybindings/matchers";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import {
	__resetDirsFromEnvForTests,
	getAgentDir,
	getProfileRootDir,
	removeWithRetries,
	setProfile,
} from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** The key event a terminal sends for `raw`, as the pi-tui driver decodes it. */
function key(raw: string, kitty = false): KeyEvent {
	const event = decodeKey(raw, { kitty, backspaceIsCtrl: false });
	if (!event) throw new Error(`${JSON.stringify(raw)} decodes to no key`);
	return event;
}

const ctrl = (letter: string): KeyEvent => key(String.fromCharCode(letter.charCodeAt(0) & 31));

describe("canonicalKeyId", () => {
	it("maps config chords onto pi-tui key event ids", () => {
		expect(canonicalKeyId("shift+ctrl+p")).toBe("ctrl+shift+p");
		expect(canonicalKeyId("Super+Shift+Alt+K")).toBe("alt+shift+super+k");
		expect(canonicalKeyId("esc")).toBe("escape");
		expect(canonicalKeyId("ctrl+return")).toBe("ctrl+enter");
		expect(canonicalKeyId("pageup")).toBe("pageUp");
		expect(canonicalKeyId("A")).toBe("shift+a");
		expect(canonicalKeyId("shift+?")).toBe("?");
		expect(canonicalKeyId("ctrl++")).toBe("ctrl++");
		expect(canonicalKeyId("+")).toBe("+");
	});

	it("matches what the driver decodes for each spelling", () => {
		expect(canonicalKeyId("shift+ctrl+p")).toBe(key("\x1b[112;6u", true).id);
		expect(canonicalKeyId("A")).toBe(key("A").id);
		expect(canonicalKeyId("shift+?")).toBe(key("?").id);
		expect(canonicalKeyId("esc")).toBe(key("\x1b").id);
		expect(canonicalKeyId("return")).toBe(key("\r").id);
		expect(canonicalKeyId("PageUp")).toBe(key("\x1b[5~").id);
	});
});

describe("KeybindingsManager", () => {
	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = KeybindingsManager.inMemory({ "tui.input.submit": ["enter", "ctrl+enter"] });

		expect(keybindings.keysFor("tui.input.submit")).toEqual(["enter", "ctrl+enter"]);
		expect(keybindings.keysFor("tui.select.confirm")).toEqual(["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = KeybindingsManager.inMemory({ "tui.select.up": ["up", "ctrl+p"] });

		expect(keybindings.keysFor("tui.select.up")).toEqual(["up", "ctrl+p"]);
		expect(keybindings.keysFor("tui.editor.cursorUp")).toEqual(["up"]);
		expect(keybindings.matches(ctrl("p"), "tui.select.up")).toBe(true);
		expect(keybindings.matches(key("\x1b[A"), "tui.editor.cursorUp")).toBe(true);
	});

	it("preserves Shift when matching printable uppercase letters", () => {
		const keybindings = KeybindingsManager.inMemory({ "tui.input.copy": "shift+a" });

		expect(keybindings.matches(key("A"), "tui.input.copy")).toBe(true);
		expect(keybindings.matches(key("a"), "tui.input.copy")).toBe(false);
	});

	it("reads chords case-insensitively and lists them lowercased, deduplicated", () => {
		const keybindings = KeybindingsManager.inMemory({ "app.plan.toggle": ["Alt+Shift+P" as KeyId, "alt+shift+p"] });

		expect(keybindings.keysFor("app.plan.toggle")).toEqual(["alt+shift+p"]);
		expect(keybindings.matches(key("\x1b[112;4u", true), "app.plan.toggle")).toBe(true);
	});

	it("matches every spelling of escape, enter, shifted symbols and uppercase letters", () => {
		const keybindings = KeybindingsManager.inMemory({ "tui.input.copy": ["esc", "return", "?", "shift+a"] });

		for (const raw of ["\x1b", "\r", "?", "A"]) {
			expect(keybindings.matches(key(raw), "tui.input.copy")).toBe(true);
		}
	});

	it("matches modifier chords whatever order the config lists them in", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.keysFor("app.model.cycleBackward")).toEqual(["shift+ctrl+p"]);
		expect(keybindings.matches(key("\x1b[112;6u", true), "app.model.cycleBackward")).toBe(true);
		expect(keybindings.matches(ctrl("p"), "app.model.cycleBackward")).toBe(false);
	});

	it("matches presses and repeats but never releases", () => {
		const keybindings = KeybindingsManager.inMemory();

		expect(keybindings.matches(key("\x1b[27u", true), "app.interrupt")).toBe(true);
		expect(keybindings.matches(key("\x1b[27;1:2u", true), "app.interrupt")).toBe(true);
		expect(keybindings.matches(key("\x1b[27;1:3u", true), "app.interrupt")).toBe(false);
	});

	it("unbinds an action set to an empty list", () => {
		const keybindings = KeybindingsManager.inMemory({ "app.history.search": [] });

		expect(keybindings.keysFor("app.history.search")).toEqual([]);
		expect(keybindings.matches(ctrl("r"), "app.history.search")).toBe(false);
		expect(keybindings.resolvedBindings()["app.history.search"]).toEqual([]);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = KeybindingsManager.inMemory({
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		expect(keybindings.conflicts()).toEqual([
			{ key: "ctrl+x", keybindings: ["tui.input.submit", "tui.select.confirm"] },
		]);
		expect(keybindings.keysFor("tui.editor.cursorLeft")).toEqual(["left", "ctrl+b"]);
	});

	it("ignores unknown actions in the config", () => {
		const keybindings = KeybindingsManager.inMemory({ "unknown.action": "ctrl+x", "tui.input.submit": "ctrl+x" });

		expect(keybindings.conflicts()).toEqual([]);
		expect(keybindings.resolvedBindings()).not.toHaveProperty("unknown.action");
	});

	it("applies new user bindings on setUserBindings", () => {
		const keybindings = KeybindingsManager.inMemory();
		keybindings.setUserBindings({ "app.retry": "f6" });

		expect(keybindings.keysFor("app.retry")).toEqual(["f6"]);
		expect(keybindings.matches(key("\x1b[17~"), "app.retry")).toBe(true);
		expect(keybindings.matches(key("\x1b[15~"), "app.retry")).toBe(false);
	});
});

describe("default keymap", () => {
	afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

	it("defaults retry to F5 with the Alt+R fallback", () => {
		expect(getKeybindings().keysFor("app.retry")).toEqual(["f5", "alt+r"]);
	});

	it("keeps the Ctrl+L live toggle default when an old model remap still claims Ctrl+L", () => {
		const manager = KeybindingsManager.inMemory({ "app.model.select": "ctrl+l" });

		expect(manager.keysFor("app.model.select")).toEqual(["ctrl+l"]);
		expect(manager.keysFor("app.live.toggle")).toEqual(["ctrl+l"]);
		expect(manager.resolvedBindings()["app.live.toggle"]).toBe("ctrl+l");
	});

	it("keeps Ctrl+L when the user explicitly assigns it to display reset", () => {
		const manager = KeybindingsManager.inMemory({ "app.display.reset": "ctrl+l" });

		expect(manager.keysFor("app.display.reset")).toEqual(["ctrl+l"]);
	});

	it("removes the Ctrl+Q follow-up default when a user remap already claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({ "app.plan.toggle": "ctrl+q" });
		setKeybindings(manager);

		expect(manager.keysFor("app.plan.toggle")).toEqual(["ctrl+q"]);
		expect(manager.keysFor("app.message.followUp")).toEqual(["ctrl+enter"]);
		expect(manager.resolvedBindings()["app.message.followUp"]).toBe("ctrl+enter");
		expect(manager.matches(ctrl("q"), "app.message.followUp")).toBe(false);
		expect(manager.matches(ctrl("q"), "app.plan.toggle")).toBe(true);
		expect(matchesAnyKey(ctrl("q"), appFollowUpKeys())).toBe(false);
		expect(matchesAnyKey(key("\x1b[13;5u", true), appFollowUpKeys())).toBe(true);
	});

	it("removes the Shift+Up dequeue default when a user remap already claims it", () => {
		const manager = KeybindingsManager.inMemory({ "app.session.new": "shift+up" });

		expect(manager.keysFor("app.message.dequeue")).toEqual(["alt+up"]);
	});

	it("keeps the Ctrl+Q follow-up default when only an unknown config key claims it (#1903)", () => {
		const manager = KeybindingsManager.inMemory({ "unknown.action": "ctrl+q" });

		expect(manager.keysFor("app.message.followUp")).toEqual(["ctrl+q", "ctrl+enter"]);
	});

	it("keeps Ctrl+Q when the user explicitly assigns it to follow-up (#1903)", () => {
		const manager = KeybindingsManager.inMemory({ "app.message.followUp": "ctrl+q" });

		expect(manager.keysFor("app.message.followUp")).toEqual(["ctrl+q"]);
	});

	it("falls back to Ctrl+Enter and Ctrl+Q for follow-up when the user unbinds it", () => {
		const manager = KeybindingsManager.inMemory({ "app.message.followUp": [] });

		expect(appFollowUpKeys(manager)).toEqual(["ctrl+enter", "ctrl+q"]);
		expect(matchesAnyKey(ctrl("q"), appFollowUpKeys(manager))).toBe(true);
	});

	it("keeps the default Hub chord off Ctrl+S", () => {
		const manager = KeybindingsManager.inMemory();

		expect(manager.keysFor("app.agents.hub")).toEqual(["alt+a"]);
		expect(manager.keysFor("app.editor.stash")).toEqual(["ctrl+s"]);
		expect(manager.resolvedBindings()).not.toHaveProperty("app.session.observe");
	});

	it("preserves an explicit Hub Ctrl+S remap instead of silently binding stash over it", () => {
		const manager = KeybindingsManager.inMemory({ "app.agents.hub": "ctrl+s" });

		expect(manager.keysFor("app.agents.hub")).toEqual(["ctrl+s"]);
		expect(manager.keysFor("app.editor.stash")).toEqual([]);
		expect(manager.resolvedBindings()["app.editor.stash"]).toEqual([]);
	});

	it("keeps the editor stash despite a configured session-selector sort shortcut", () => {
		const manager = KeybindingsManager.inMemory({ "app.session.toggleSort": "ctrl+s" });

		expect(manager.keysFor("app.editor.stash")).toEqual(["ctrl+s"]);
		expect(manager.keysFor("app.session.toggleSort")).toEqual(["ctrl+s"]);
		expect(manager.resolvedBindings()["app.editor.stash"]).toBe("ctrl+s");
	});

	it("still gives an explicit Hub remap precedence when selector sort shares the chord", () => {
		const manager = KeybindingsManager.inMemory({
			"app.session.toggleSort": "ctrl+s",
			"app.agents.hub": "ctrl+s",
		});

		expect(manager.keysFor("app.editor.stash")).toEqual([]);
		expect(manager.keysFor("app.agents.hub")).toEqual(["ctrl+s"]);
	});
});

describe("getDefaultPasteImageKeys", () => {
	it("keeps Ctrl+V registered for image paste on Windows alongside the terminal-safe fallback", () => {
		expect(getDefaultPasteImageKeys("win32")).toEqual(["ctrl+v", "alt+v"]);
	});

	it("adds the macOS Command key event to Ctrl+V for image paste", () => {
		expect(getDefaultPasteImageKeys("linux")).toEqual(["ctrl+v"]);
		expect(getDefaultPasteImageKeys("darwin")).toEqual(["ctrl+v", "super+v"]);
	});
});

async function writeKeybindingsYaml(agentDir: string, config: KeybindingsConfig): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(agentDir, "keybindings.yml"), YAML.stringify(config, null, 2));
}

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

describe("KeybindingsManager.create", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-keybindings-"));
	});

	afterEach(async () => {
		setKeybindings(KeybindingsManager.inMemory());
		await removeWithRetries(tempDir);
	});

	it("migrates legacy keybinding JSON to YAML and becomes the global keymap", async () => {
		const jsonPath = path.join(tempDir, "keybindings.json");
		await Bun.write(
			jsonPath,
			JSON.stringify({ fork: "ctrl+f", selectConfirm: "enter", cursorUp: "ctrl+p", selectModelTemporary: "alt+y" }),
		);

		const manager = KeybindingsManager.create(tempDir);
		const written = YAML.parse(await Bun.file(path.join(tempDir, "keybindings.yml")).text());

		expect(getKeybindings()).toBe(manager);
		expect(manager.keysFor("app.session.fork")).toEqual(["ctrl+f"]);
		expect(manager.keysFor("tui.select.confirm")).toEqual(["enter"]);
		expect(manager.keysFor("tui.editor.cursorUp")).toEqual(["ctrl+p"]);
		expect(manager.keysFor("app.model.selectTemporary")).toEqual(["alt+y"]);
		expect(written).toEqual({
			"app.model.selectTemporary": "alt+y",
			"app.session.fork": "ctrl+f",
			"tui.editor.cursorUp": "ctrl+p",
			"tui.select.confirm": "enter",
		});
		expect(Object.keys(written as object)).toEqual([
			"tui.editor.cursorUp",
			"tui.select.confirm",
			"app.model.selectTemporary",
			"app.session.fork",
		]);
		expect(await Bun.file(jsonPath).exists()).toBe(true);
	});

	it("migrates legacy keybinding JSON with comments", async () => {
		await Bun.write(
			path.join(tempDir, "keybindings.json"),
			`{
	// Legacy config files may contain comments from hand-edited examples.
	"fork": "ctrl+f",
	"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"]
}
`,
		);

		const manager = KeybindingsManager.create(tempDir);

		expect(manager.keysFor("app.session.fork")).toEqual(["ctrl+f"]);
		expect(manager.keysFor("app.clipboard.copyPrompt")).toEqual(["alt+c", "ctrl+shift+c"]);
		expect(YAML.parse(await Bun.file(path.join(tempDir, "keybindings.yml")).text())).toEqual({
			"app.clipboard.copyPrompt": ["alt+c", "ctrl+shift+c"],
			"app.session.fork": "ctrl+f",
		});
	});

	it("merges both old observer names with explicit Hub chords regardless of YAML entry order", async () => {
		const configPath = path.join(tempDir, "keybindings.yml");
		await Bun.write(
			configPath,
			YAML.stringify({
				observeSessions: ["ctrl+o", "alt+o"],
				"app.session.observe": ["ctrl+s", "ctrl+o"],
				"app.agents.hub": ["ctrl+s", "alt+h"],
			}),
		);

		const manager = KeybindingsManager.create(tempDir);
		expect(manager.keysFor("app.agents.hub")).toEqual(["ctrl+s", "alt+h", "ctrl+o", "alt+o"]);
		expect(manager.keysFor("app.editor.stash")).toEqual([]);
		expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
			"app.agents.hub": ["ctrl+s", "alt+h", "ctrl+o", "alt+o"],
		});
		expect(manager.resolvedBindings()).not.toHaveProperty("app.session.observe");
		expect(manager.resolvedBindings()).not.toHaveProperty("observeSessions");
	});

	it("migrates old observer JSON remaps without a new Hub entry", async () => {
		await Bun.write(
			path.join(tempDir, "keybindings.json"),
			JSON.stringify({ observeSessions: "ctrl+o", "app.session.observe": "ctrl+s" }),
		);

		const manager = KeybindingsManager.create(tempDir);
		expect(manager.keysFor("app.agents.hub")).toEqual(["alt+a", "ctrl+s", "ctrl+o"]);
		expect(manager.keysFor("app.editor.stash")).toEqual([]);
		expect(YAML.parse(await Bun.file(path.join(tempDir, "keybindings.yml")).text())).toEqual({
			"app.agents.hub": ["alt+a", "ctrl+s", "ctrl+o"],
		});
	});

	it("loads keybindings.yml directly and reloads it", async () => {
		await writeKeybindingsYaml(tempDir, { "app.session.fork": "ctrl+f" });
		const manager = KeybindingsManager.create(tempDir);
		expect(manager.keysFor("app.session.fork")).toEqual(["ctrl+f"]);

		await writeKeybindingsYaml(tempDir, { "app.session.fork": "alt+f" });
		manager.reload();

		expect(manager.keysFor("app.session.fork")).toEqual(["alt+f"]);
	});

	it("accepts keybindings.yaml without writing keybindings.yml", async () => {
		await Bun.write(path.join(tempDir, "keybindings.yaml"), YAML.stringify({ "app.plan.toggle": "alt+shift+p" }));

		const manager = KeybindingsManager.create(tempDir);

		expect(manager.keysFor("app.plan.toggle")).toEqual(["alt+shift+p"]);
		expect(await Bun.file(path.join(tempDir, "keybindings.yml")).exists()).toBe(false);
	});

	it("keeps defaults when the config file is malformed", async () => {
		await Bun.write(path.join(tempDir, "keybindings.yml"), "app.retry: [unterminated");

		expect(KeybindingsManager.create(tempDir).keysFor("app.retry")).toEqual(["f5", "alt+r"]);
	});

	it("merges default user keybindings with profile overrides for a named profile (#4867)", async () => {
		const defaultAgentDir = path.join(tempDir, "default", "agent");
		const profileAgentDir = path.join(tempDir, "profiles", "work", "agent");
		await writeKeybindingsYaml(defaultAgentDir, { "app.session.fork": "ctrl+f", "app.session.new": "ctrl+n" });
		await writeKeybindingsYaml(profileAgentDir, { "app.session.fork": "alt+f", "app.clipboard.copyLine": "alt+l" });

		const manager = KeybindingsManager.create(profileAgentDir, { inheritedAgentDir: defaultAgentDir });

		expect(manager.keysFor("app.session.new")).toEqual(["ctrl+n"]);
		expect(manager.keysFor("app.session.fork")).toEqual(["alt+f"]);
		expect(manager.keysFor("app.clipboard.copyLine")).toEqual(["alt+l"]);
	});

	it("inherits default user keybindings for a named profile without its own file (#4867)", async () => {
		const defaultAgentDir = path.join(tempDir, "default", "agent");
		await writeKeybindingsYaml(defaultAgentDir, { "tui.editor.deleteCharBackward": ["backspace", "ctrl+h"] });

		const manager = KeybindingsManager.create(path.join(tempDir, "profiles", "work", "agent"), {
			inheritedAgentDir: defaultAgentDir,
		});

		expect(manager.keysFor("tui.editor.deleteCharBackward")).toEqual(["backspace", "ctrl+h"]);
	});

	it("never writes migration output into the inherited default agent dir (#4867)", async () => {
		const defaultAgentDir = path.join(tempDir, "default", "agent");
		await fs.mkdir(defaultAgentDir, { recursive: true });
		await Bun.write(path.join(defaultAgentDir, "keybindings.json"), JSON.stringify({ "app.session.fork": "ctrl+f" }));

		const manager = KeybindingsManager.create(path.join(tempDir, "profiles", "work", "agent"), {
			inheritedAgentDir: defaultAgentDir,
		});

		expect(manager.keysFor("app.session.fork")).toEqual(["ctrl+f"]);
		expect(await Bun.file(path.join(defaultAgentDir, "keybindings.yml")).exists()).toBe(false);
	});

	it("merges default user keybindings when create uses the active profile with no arguments (#4867)", async () => {
		const saved = {
			PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			OMP_PROFILE: process.env.OMP_PROFILE,
			PI_PROFILE: process.env.PI_PROFILE,
		};
		try {
			process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempDir);
			__resetDirsFromEnvForTests();
			const defaultAgentDir = path.join(getProfileRootDir(undefined), "agent");
			const profileAgentDir = path.join(getProfileRootDir("work"), "agent");
			await writeKeybindingsYaml(defaultAgentDir, { "app.session.fork": "ctrl+f", "app.session.new": "ctrl+n" });
			await writeKeybindingsYaml(profileAgentDir, { "app.session.fork": "alt+f" });
			setProfile("work");
			expect(getAgentDir()).toBe(profileAgentDir);

			const manager = KeybindingsManager.create();

			expect(manager.keysFor("app.session.new")).toEqual(["ctrl+n"]);
			expect(manager.keysFor("app.session.fork")).toEqual(["alt+f"]);
		} finally {
			for (const [name, value] of Object.entries(saved)) restoreEnvValue(name, value);
			__resetDirsFromEnvForTests();
		}
	});
});
