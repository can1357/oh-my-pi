import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StdinBuffer } from "@oh-my-pi/pi-tui/stdin-buffer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

// An Enter and the following paste bytes can arrive in one stdin read. The
// asynchronous submit handler must never clear the bytes after Enter.
describe("InteractiveMode paste type-ahead", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let tempDir: TempDir;
	let mode: InteractiveMode;
	let session: AgentSession;

	beforeAll(() => {
		initTheme();
		tempDir = TempDir.createSync("@pi-paste-typeahead-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, () => {}, [], undefined, undefined);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init();
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	for (const streaming of [false, true]) {
		it(`preserves text after Enter while ${streaming ? "streaming" : "idle"}`, async () => {
			const submitted: string[] = [];
			mode.onInputCallback = input => submitted.push(input.text);
			vi.spyOn(session, "maybeStartTitleGeneration").mockImplementation(() => {});
			if (streaming) {
				vi.spyOn(session, "prompt").mockResolvedValue(true);
				Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			}
			const submit = mode.editor.onSubmit;
			const done = Promise.withResolvers<void>();
			mode.editor.onSubmit = async text => {
				try {
					await submit?.(text);
				} finally {
					done.resolve();
				}
			};
			const stdin = new StdinBuffer();
			stdin.setRawPasteClassification(false);
			stdin.on("data", data => mode.editor.handleInput(data));
			stdin.process("first\rtyped after Enter");
			await done.promise;
			expect(mode.editor.getText()).toBe("typed after Enter");
			if (!streaming) expect(submitted).toEqual(["first"]);
		});
	}
});
