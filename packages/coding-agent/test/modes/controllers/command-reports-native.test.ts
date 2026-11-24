import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { reportTextView } from "../../../src/modes/controllers/command-views";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { jsx, signal, type TextEdit } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TspTableProps } from "@oh-my-pi/pi-wire";
import { initTheme } from "../../../src/ui/theme/service";
import { pressKey } from "../../helpers/mode-terminal";
import { nativeShell } from "../../helpers/native-shell";

describe("command reports in Tern", () => {
	beforeAll(() => {
		initTheme();
	});

	/** A Tern shell whose composer editor holds the keys, as while a command is typed. */
	async function tern() {
		const ui = await nativeShell();
		const draft = signal("");
		ui.shell.dock.slot("composer").set(() =>
			jsx("editor", {
				text: draft,
				cursor: () => draft().length,
				onEdit: (edit: TextEdit) => draft.set(draft().slice(0, edit.from) + edit.text + draft().slice(edit.to)),
			}),
		);
		ui.send({ ev: "focus", sf: ui.sf, id: ui.node("editor").id });
		return {
			ui,
			/** The composer's text. */
			draft,
			controller(session: object = {}): CommandController {
				return new CommandController({
					shell: ui.shell,
					keybindings: KeybindingsManager.inMemory(),
					commandReportRows: () => undefined,
					session,
					showWarning: () => {},
				} as unknown as InteractiveModeContext);
			},
			/** The sheet in the layer and the column it wraps. */
			sheet() {
				const overlay = ui.node("overlay");
				expect(overlay.parent).toBe("layer");
				expect(overlay.c).toHaveLength(1);
				return { overlay, content: ui.get(overlay.c[0]!) };
			},
			[Symbol.asyncDispose]: () => ui[Symbol.asyncDispose](),
		};
	}

	it("mounts /tools as the report sheet titled by the report, and Close returns the keys to the composer", async () => {
		await using app = await tern();
		const { ui, draft } = app;
		app.controller({
			agent: { state: { tools: [{ name: "read", description: "Reads a file" }] } },
			getToolCommandEntries: () => [],
		}).handleToolsCommand();

		const { overlay, content } = app.sheet();
		expect(overlay.p).toEqual({
			role: "omp.overlay.report",
			head: "Available Tools",
			anchor: "center",
			size: "lg",
			modal: true,
		});
		// The sheet is the frame: the panel inside carries no role of its own.
		expect(content.p).toEqual({ gap: "md" });
		const body = ui.node("col", "body");
		expect(body.parent).toBe(content.id);
		expect(body.p.role).toBe("omp.report.body");
		const markdown = ui.get(body.c[0]!);
		expect(markdown.k).toBe("md");
		expect(String(markdown.p.text)).toContain("| `read` | Reads a file |");
		expect(ui.node("row", "actions").parent).toBe(content.id);

		ui.click("button", "close");
		expect(ui.shell.overlays.open()).toBe(false);
		ui.type("next");
		expect(draft()).toBe("next");
	});

	it("sends a styled text report as wrapped text whose spans carry theme colors, and Escape closes it", async () => {
		await using app = await tern();
		const { ui, draft } = app;
		const text = `Manage servers.\n\n${currentTheme().fg("accent", "Commands:")}\n  /mcp list`;
		app.controller().showCommandReport({ title: "MCP Server Management", body: () => reportTextView(text) });

		const { overlay } = app.sheet();
		expect(overlay.p).toMatchObject({ role: "omp.overlay.report", head: "MCP Server Management" });
		const report = ui.get(ui.node("col", "body").c[0]!);
		expect(report.k).toBe("text");
		expect(report.p).toEqual({
			wrap: "word",
			spans: [{ t: "Manage servers.\n\n" }, { t: "Commands:", s: "accent" }, { t: "\n  /mcp list" }],
		});

		pressKey(ui.shell, "escape");
		expect(ui.shell.overlays.open()).toBe(false);
		ui.type("next");
		expect(draft()).toBe("next");
	});

	it("sends the /changelog markdown without the escapes of its closing hint", async () => {
		await using app = await tern();
		const { ui } = app;
		await app.controller().handleChangelogCommand("last");

		expect(app.sheet().overlay.p).toMatchObject({ role: "omp.overlay.report", head: "Last Release" });
		const markdown = String(ui.get(ui.node("col", "body").c[0]!).p.text);
		expect(markdown).not.toContain("\x1b");
		expect(markdown.endsWith("Use /changelog full to view the complete changelog.")).toBe(true);
	});

	it("mounts /hotkeys as the keyboard-shortcuts sheet of grouped keycap tables, closed by Close or Escape", async () => {
		await using app = await tern();
		const { ui, draft } = app;
		const command = app.controller();
		command.handleHotkeysCommand();

		const { overlay, content } = app.sheet();
		// The peer is a narrow pane (under 100 columns): a centered sheet this tall fills it.
		expect(overlay.p).toEqual({
			role: "omp.overlay.hotkeys",
			head: "Keyboard shortcuts",
			anchor: "center",
			size: "full",
			modal: true,
		});
		expect(content.p).toEqual({ gap: "lg" });
		const groups = content.c.map(id => ui.get(id));
		expect(groups.map(group => [group.k, group.p.head ?? group.p.role])).toEqual([
			["section", "Navigation"],
			["section", "Editing"],
			["section", "Other"],
			["row", "omp.actions"],
		]);
		const navigation = ui.get(groups[0]!.c[0]!);
		expect(navigation.k).toBe("table");
		expect(navigation.p).toMatchObject({
			role: "omp.hotkeys.table",
			cols: [
				{ id: "keys", head: "Key" },
				{ id: "action", head: "Action", grow: 1 },
			],
		});
		const rows = navigation.p.rows as TspTableProps["rows"];
		// Key ids travel as `key` spans (Tern draws the keycaps); prose and code keep their own tokens.
		expect(rows[1]).toEqual({
			id: "1",
			cells: {
				keys: [
					{ t: "alt+left", s: "key" },
					{ t: " ", s: "dim" },
					{ t: "alt+right", s: "key" },
				],
				action: [{ t: "Move by word" }],
			},
		});
		const other = (ui.get(groups[2]!.c[0]!).p.rows as TspTableProps["rows"]).map(row => row.cells);
		expect(other).toContainEqual({
			keys: [{ t: "!!", s: "code" }],
			action: [{ t: "Run bash command (excluded from context)" }],
		});
		expect(other.find(cells => JSON.stringify(cells.action).includes("GitHub issue/PR reference"))?.action).toEqual([
			{ t: "GitHub issue/PR reference (e.g. " },
			{ t: "#3164", s: "code" },
			{ t: " → " },
			{ t: "pr://", s: "code" },
			{ t: "/" },
			{ t: "issue://", s: "code" },
			{ t: ")" },
		]);

		ui.click("button", "close");
		expect(ui.shell.overlays.open()).toBe(false);
		command.handleHotkeysCommand();
		expect(ui.node("overlay").p.role).toBe("omp.overlay.hotkeys");
		pressKey(ui.shell, "escape");
		expect(ui.shell.overlays.open()).toBe(false);
		ui.type("next");
		expect(draft()).toBe("next");
	});

	describe("/context", () => {
		let authStorage: AuthStorage;
		let session: AgentSession;
		let tempDir: TempDir;

		beforeEach(async () => {
			resetSettingsForTest();
			tempDir = TempDir.createSync("@pi-context-native-");
			await Settings.init({ inMemory: true, cwd: tempDir.path() });
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
			session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["one system block"], tools: [] },
				}),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
				modelRegistry,
				autoTitle: false,
			});
		});

		afterEach(async () => {
			await session?.dispose();
			authStorage?.close();
			tempDir?.removeSync();
			resetSettingsForTest();
		});

		it("mounts the viewer as a report sheet whose title follows the open category, and Escape steps back out to the composer", async () => {
			await using app = await tern();
			const { ui, draft } = app;
			app.controller(session).handleContextCommand();

			const { overlay, content } = app.sheet();
			expect(overlay.p).toEqual({
				role: "omp.overlay.report",
				head: [
					{ t: "Context", s: "strong" },
					{ t: ` · ${session.model?.name}`, s: "muted" },
				],
				anchor: "center",
				// A narrow pane: the viewer's list is tall enough to fill it.
				size: "full",
				modal: true,
			});
			expect(content.p.role).toBe("omp.context");

			// The system prompt holds one block: activating it opens that entry, titled by its category.
			const categories = ui.node("list", "categories");
			ui.send({ ev: "activate", sf: ui.sf, id: categories.id, item: ui.node("item", "system-prompt").id });
			expect(ui.node("overlay").p.head).toEqual([
				{ t: "Context", s: "strong" },
				{ t: " · System Prompt", s: "muted" },
			]);

			pressKey(ui.shell, "escape");
			expect(ui.node("overlay").p.head).toEqual(overlay.p.head);
			pressKey(ui.shell, "escape");
			expect(ui.shell.overlays.open()).toBe(false);
			ui.type("next");
			expect(draft()).toBe("next");
		});
	});
});
