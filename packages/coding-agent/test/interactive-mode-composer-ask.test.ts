/**
 * Contract: while an ask waits above the composer and sending the draft would skip it, the
 * composer says so natively: a `skips ask` chip leads the input and Send reads Skip & send
 * (`omp.composer.skip`). Tern styles both as a warning; without them the user skips the
 * questions with a plain-looking Send.
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
import { createRoot } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

/** A node as the native backend describes it. */
interface NativeNode {
	readonly k: string;
	readonly key?: string;
	readonly p?: Readonly<Record<string, unknown>>;
	readonly c?: readonly NativeNode[];
}

function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).flatMap(nodes)];
}

const FORM = `<form><label><input type="radio" name="db" value="sqlite" checked> SQLite</label></form>`;

describe("composer under a waiting ask", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: ModeTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-composer-ask-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		term = createModeTerminal({ columns: 100, rows: 30 });
		await term.start();
		vi.spyOn(term.frame.shell, "native").mockImplementation(() => true);
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** The composer's parts the host receives, by role. */
	function composerRoles(): Map<unknown, NativeNode> {
		const env = staticEnvironment(currentTheme());
		const tree = createRoot(dispose => {
			try {
				return describeTree(mode.composer.node, env, 100) as NativeNode;
			} finally {
				dispose();
			}
		});
		return new Map(nodes(tree).map(node => [node.p?.role, node]));
	}

	it("reads Skip & send behind a `skips ask` chip only while the draft would skip the ask", async () => {
		const abort = new AbortController();
		const form = mode.getToolUIContext()?.formDialog?.(FORM, { signal: abort.signal });
		if (!form) throw new Error("the interactive mode offers no form dialog");

		// The ask alone: an empty draft sends nothing, so Send stays Send.
		expect(composerRoles().has("omp.composer.skip")).toBe(false);
		expect(composerRoles().has("omp.composer.send")).toBe(true);

		mode.composer.setText("never mind, just ship it");
		const skipping = composerRoles();
		expect(skipping.get("omp.composer.skip")?.p).toMatchObject({ text: "Skip & send", actions: { click: "submit" } });
		expect(skipping.has("omp.composer.send")).toBe(false);
		expect(skipping.get("omp.composer.mode")?.c?.[0]?.p).toMatchObject({ spans: [{ t: "skips ask" }] });

		// A command is not a message to the agent: it skips nothing.
		mode.composer.setText("/model");
		expect(composerRoles().has("omp.composer.skip")).toBe(false);
		expect(composerRoles().has("omp.composer.mode")).toBe(false);

		// The ask gone, a draft is a plain message again.
		mode.composer.setText("ship it");
		expect(composerRoles().has("omp.composer.skip")).toBe(true);
		abort.abort();
		await form;
		expect(composerRoles().has("omp.composer.skip")).toBe(false);
		expect(composerRoles().has("omp.composer.send")).toBe(true);
	});

	// The `ask` tool shows the HTML form; extensions' `ui.askDialog` shows the rich ask dialog.
	it.each([
		["ask tool form", (signal: AbortSignal) => mode.getToolUIContext()?.formDialog?.(FORM, { signal })],
		[
			"ask dialog",
			(signal: AbortSignal) =>
				mode
					.getToolUIContext()
					?.askDialog?.([{ id: "go", question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }], {
						signal,
					}),
		],
	] as const)("lets Alt+L reset the display while the %s holds the keys (#20771)", async (surface, open) => {
		const reset = vi.spyOn(mode, "resetDisplayAfterAppearanceRefresh").mockImplementation(() => {});
		const abort = new AbortController();
		const ask = open(abort.signal);
		if (!ask) throw new Error(`the interactive mode offers no ${surface}`);
		await term.settle();
		expect(mode.shell.focused()?.props().role).toBe("omp.ask.card");

		term.press("alt+l");
		await term.settle();
		expect(reset).toHaveBeenCalledTimes(1);
		abort.abort();
		await ask;
	});
});
