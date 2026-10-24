/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * What the inline selectors and hook dialogs send a Tern terminal: each replaces the composer in
 * the dock, as a card there or as a `picker` Tern hoists into `layer`, and the composer comes back
 * when it closes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { TempDir } from "@oh-my-pi/pi-utils";
import { HistorySearch } from "../src/ui/overlays/pickers/history-search";
import { ResetUsageSelector } from "../src/ui/overlays/pickers/reset-usage-selector";
import { TreeSelector, type TreeSelectorNode } from "../src/ui/overlays/pickers/tree-selector";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";
import { nativeShell } from "./helpers/native-shell";

/** The lookup of the native-shell helper these checks read the document through. */
interface NativeDocument {
	node(kind: string, key?: string): { parent: string | null; p: Record<string, unknown> };
}

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b[27u";

describe("inline selectors in a Tern terminal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-selectors-native-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	/** Whether the native document holds a node of `kind`. */
	const has = (ui: NativeDocument, kind: string): boolean => {
		try {
			ui.node(kind);
			return true;
		} catch {
			return false;
		}
	};
	/** The picker Tern holds: hoisted into `layer`, with the composer out of the dock. */
	const sheet = (ui: NativeDocument): TspPickerProps => {
		const picker = ui.node("picker");
		expect(picker.parent).toBe("layer");
		expect(has(ui, "editor")).toBe(false);
		return picker.p as TspPickerProps;
	};

	it("/debug is a titled card in the composer's place: keys move and filter its list, Escape restores the composer", async () => {
		await using ui = await nativeShell(mode.shell);
		expect(has(ui, "editor")).toBe(true);
		await mode.showDebugSelector();

		const card = ui.node("card");
		expect(card.id.startsWith("dock/")).toBe(true);
		expect(card.p).toMatchObject({ role: "omp.overlay", head: "Debug Tools" });
		expect(has(ui, "picker")).toBe(false);
		expect(has(ui, "editor")).toBe(false);
		const list = () => ui.node("list", "list");
		expect(list().p).toMatchObject({ empty: "No items", max: { lines: 7 } });
		expect(list().c).toHaveLength(14);
		expect(list().p.selected).toBe(ui.node("item", "open-artifacts").id);
		expect(ui.node("text", "status").p.spans).toEqual([{ s: "muted", t: "Type to search" }]);

		ui.type(DOWN);
		expect(list().p.selected).toBe(ui.node("item", "performance").id);
		ui.type("log");
		expect(list().p.filter).toBe("log");
		expect(ui.node("text", "status").p.spans).toEqual([{ s: "muted", t: "Search: log" }]);
		expect(list().c.length).toBeLessThan(14);
		expect(list().c).toContain(ui.node("item", "logs").id);

		ui.type(ESCAPE);
		expect(has(ui, "card")).toBe(false);
		expect(has(ui, "editor")).toBe(true);
	});

	it("/debug runs the tool a click on its row names and gives the composer back", async () => {
		await using ui = await nativeShell(mode.shell);
		await mode.showDebugSelector();
		const blocks = mode.shell.transcript.blocks().length;
		ui.send({ ev: "select", sf: ui.sf, id: ui.node("list", "list").id, item: "terminal" });
		await Bun.sleep(0);

		expect(has(ui, "card")).toBe(false);
		expect(has(ui, "editor")).toBe(true);
		expect(mode.shell.transcript.blocks().length).toBeGreaterThan(blocks);
	});

	it("/login marks a provider without a credential as not signed in, not as failed", async () => {
		await using ui = await nativeShell(mode.shell);
		const checked = vi.spyOn(session.modelRegistry, "getApiKeyForProvider");
		await mode.showOAuthSelector("login");

		const picker = sheet(ui);
		expect(picker).toMatchObject({ title: "Sign in", layout: "cards", size: "md" });
		const unconfigured = picker.items!.filter(item => item.detail === "Not configured");
		expect(unconfigured.length).toBeGreaterThan(0);
		expect(unconfigured.every(item => item.dot === "muted")).toBe(true);
		// Only credentials the picker can act on are validated.
		const validated = new Set(checked.mock.calls.map(call => call[0]));
		expect(unconfigured.some(item => validated.has(item.id))).toBe(false);

		ui.type(ESCAPE);
		expect(has(ui, "picker")).toBe(false);
		expect(has(ui, "editor")).toBe(true);
	});

	it("/logout lists the signed-in provider, then its accounts, each as a hoisted picker", async () => {
		await authStorage.credentials.set(
			"anthropic",
			["org-a", "org-b"].map(orgId => ({
				type: "oauth" as const,
				access: `token-${orgId}`,
				refresh: `refresh-${orgId}`,
				expires: Date.now() + 3_600_000,
				accountId: `account-${orgId}`,
				email: `${orgId}@example.test`,
				orgId,
			})),
		);
		await using ui = await nativeShell(mode.shell);
		await mode.showOAuthSelector("logout");
		const providers = sheet(ui);
		expect(providers.title).toBe("Sign out");
		expect(providers.items!.map(item => item.id)).toEqual(["anthropic"]);

		await mode.showOAuthSelector("logout", "anthropic");
		const accounts = sheet(ui);
		expect(accounts.items).toHaveLength(2);
		ui.type(ESCAPE);
		expect(has(ui, "picker")).toBe(false);
		expect(has(ui, "editor")).toBe(true);
	});

	it("/session pin picks an account of the model's provider from a hoisted picker", async () => {
		await authStorage.credentials.set(
			"anthropic",
			["org-a", "org-b"].map(orgId => ({
				type: "oauth" as const,
				access: `token-${orgId}`,
				refresh: `refresh-${orgId}`,
				expires: Date.now() + 3_600_000,
				accountId: `account-${orgId}`,
				email: `${orgId}@example.test`,
				orgId,
			})),
		);
		await using ui = await nativeShell(mode.shell);
		await mode.showSessionPinSelector();
		const picker = sheet(ui);
		expect(picker.items).toHaveLength(2);
		expect(picker.selected).toBe(picker.items![0]!.id);

		ui.type(DOWN);
		expect(ui.node("picker").p.selected).toBe(picker.items![1]!.id);
		ui.type(ENTER);
		expect(has(ui, "picker")).toBe(false);
		expect(has(ui, "editor")).toBe(true);
		expect(authStorage.oauth.accounts("anthropic", session.sessionId).find(account => account.active)?.orgId).toBe(
			"org-b",
		);
	});

	it("/effort is a hoisted picker whose row click highlights and whose confirm applies the level", async () => {
		await using ui = await nativeShell(mode.shell);
		mode.showThinkingSelector();
		const picker = sheet(ui);
		expect(picker).toMatchObject({ title: "Thinking level", size: "md", layout: "rows" });
		const target = picker.items!.find(item => item.id !== picker.selected)!;

		ui.send({ ev: "select", sf: ui.sf, id: ui.node("picker").id, item: target.id });
		expect(ui.node("picker").p.selected).toBe(target.id);
		ui.send({ ev: "action", sf: ui.sf, id: ui.node("picker").id, act: "confirm" });
		expect(has(ui, "picker")).toBe(false);
		expect(has(ui, "editor")).toBe(true);
		expect(String(session.configuredThinkingLevel())).toBe(target.id);
	});

	it("history search, the session tree and the reset picker are hoisted pickers in the composer's place", async () => {
		await using ui = await nativeShell(mode.shell);
		const entries = [
			{ id: 1, prompt: "first prompt", created_at: 1_700_000_000 },
			{ id: 2, prompt: "second prompt", created_at: 1_700_000_100 },
		];
		const history = mode.showEditorAreaDialog(() => (
			<HistorySearch
				source={{ search: () => entries, getRecent: () => entries, delete: () => {} }}
				onSelect={() => {}}
				onCancel={() => {}}
			/>
		));
		expect(sheet(ui)).toMatchObject({
			title: "History",
			size: "md",
			noun: "prompts",
			placeholder: "Search prompts…",
		});
		expect(sheet(ui).items!.map(item => item.label)).toEqual(["first prompt", "second prompt"]);
		history.close();
		expect(has(ui, "editor")).toBe(true);

		const result: TreeSelectorNode = {
			entry: {
				type: "message",
				id: "result",
				parentId: "call",
				timestamp: "2026-01-01T00:00:00Z",
				message: {
					role: "toolResult",
					toolCallId: "t1",
					toolName: "bash",
					content: [{ type: "text", text: "alpha\nbeta\n" }],
					isError: false,
					timestamp: 0,
				},
			},
			children: [],
		};
		const roots: TreeSelectorNode[] = [
			{
				entry: {
					type: "message",
					id: "user",
					parentId: null,
					timestamp: "2026-01-01T00:00:00Z",
					message: { role: "user", content: "# Title\n\nbody  text", timestamp: 0 },
				},
				children: [result],
			},
		];
		const tree = mode.showEditorAreaDialog(() => (
			<TreeSelector
				roots={roots}
				currentLeafId="result"
				terminalHeight={40}
				onSelect={() => {}}
				onCancel={() => {}}
			/>
		));
		const treeSheet = sheet(ui);
		expect(treeSheet).toMatchObject({ title: "Session tree", size: "lg", layout: "tree", preview: "side" });
		// Row text folds line breaks to spaces and keeps the other spacing.
		expect(treeSheet.items![0]!.label).toEqual([
			{ t: "user: ", s: "accent strong" },
			{ t: "# Title  body  text", s: "accent strong" },
		]);
		// The selected tool result previews as what `/copy` would take: named by its tool, output as code.
		expect(treeSheet.selected).toBe("result");
		expect(ui.node("text").p).toMatchObject({ role: "omp.picker.title", text: "Bash result" });
		expect(ui.node("code").p).toMatchObject({ text: "alpha\nbeta", wrap: true });
		tree.close();

		const reset = mode.showEditorAreaDialog(() => (
			<ResetUsageSelector
				accounts={[
					{
						label: "one@example.test",
						provider: "anthropic",
						providerLabel: "Claude",
						availableCount: 2,
						redeemableCount: 2,
						target: { credentialId: 1, provider: "anthropic" },
						active: true,
					},
				]}
				onSelect={() => {}}
				onCancel={() => {}}
			/>
		));
		expect(sheet(ui)).toMatchObject({ title: "Rate-limit resets", size: "md" });
		reset.close();
		expect(has(ui, "picker")).toBe(false);
		expect(has(ui, "editor")).toBe(true);
	});

	it("a hook select is a hoisted picker; an inline one is a dock card whose row click answers", async () => {
		await using ui = await nativeShell(mode.shell);
		const plain = mode.showHookSelector("Pick a fruit", ["Apple", "Banana"]);
		expect(sheet(ui)).toMatchObject({ title: "Pick a fruit", size: "md", noun: "options" });
		ui.type(DOWN);
		ui.type(ENTER);
		expect(await plain).toBe("Banana");
		expect(has(ui, "editor")).toBe(true);

		const inline = mode.showHookSelector("Save where?", ["Project", "Global"], { inline: true });
		const card = ui.node("card");
		expect(card.id.startsWith("dock/")).toBe(true);
		expect(card.p).toMatchObject({ role: "omp.overlay.hook-select", head: "Save where?" });
		expect(has(ui, "picker")).toBe(false);
		expect(has(ui, "editor")).toBe(false);
		ui.send({ ev: "select", sf: ui.sf, id: ui.node("list", "list").id, item: "1" });
		expect(await inline).toBe("Global");
		expect(has(ui, "card")).toBe(false);
		expect(has(ui, "editor")).toBe(true);
	});

	it("a hook confirm answers from its picker; hook input and editor take the composer's place with the keyboard", async () => {
		await using ui = await nativeShell(mode.shell);
		const confirm = mode.showHookConfirm("Delete?", "This cannot be undone.");
		expect(sheet(ui)).toMatchObject({ title: "Delete?", subtitle: "This cannot be undone." });
		ui.type(ENTER);
		expect(await confirm).toBe(true);

		const input = mode.showHookInput("Name the thing", "e.g. widget");
		const field = ui.node("input");
		expect(field.id.startsWith("dock/")).toBe(true);
		expect(has(ui, "editor")).toBe(false);
		ui.type("gadget");
		expect(ui.node("input").p.text).toBe("gadget");
		ui.type(ENTER);
		expect(await input).toBe("gadget");
		expect(has(ui, "editor")).toBe(true);

		const editor = mode.showHookEditor("Describe the thing", "first line");
		const area = ui.node("editor");
		expect(area.id.startsWith("dock/")).toBe(true);
		// The editor may fill the pane less the rows its chrome and the status rows take.
		expect(area.p).toMatchObject({ text: "first line", maxLines: Math.max(3, mode.shell.size().rows - 12) });
		ui.type(ESCAPE);
		expect(await editor).toBeUndefined();
		expect(ui.node("editor").p.text).toBe("");
	});
});
