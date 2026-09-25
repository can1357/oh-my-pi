import { beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import { ProfileEditorComponent, ProfileEmojiPicker } from "@oh-my-pi/pi-coding-agent/modes/components/profile-editor";
import { draftModelRoles, getSetupGroupSettings } from "@oh-my-pi/pi-coding-agent/profiles/setups";
import { projectProfileRoles } from "@oh-my-pi/pi-coding-agent/profiles/snapshot";
import { PROFILE_EMOJIS, type ProfileDraft, type ProfileEmoji } from "@oh-my-pi/pi-coding-agent/profiles/types";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

beforeAll(async () => {
	await initTheme(false);
});

function modelsOnlyDraft(): ProfileDraft {
	return {
		metadata: { version: 1, enabledGroups: [] },
		config: { modelRoles: { default: "anthropic/fixture-model" } },
	};
}

function draftValue(draft: ProfileDraft, path: string): unknown {
	let current: unknown = draft.config;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function createEditor(overrides: Partial<ConstructorParameters<typeof ProfileEditorComponent>[0]> = {}) {
	const saved: Array<{ draft: ProfileDraft; saveAsNew: boolean }> = [];
	const cancelled = vi.fn();
	const editor = new ProfileEditorComponent({
		draft: modelsOnlyDraft(),
		effectiveSettings: Settings.isolated({ "compaction.enabled": false }),
		terminalHeight: 24,
		callbacks: {
			requestRender: () => {},
			onEditRole: async (_role, draft) => draft,
			onEditAgents: async draft => draft,
			onSave: (draft, saveAsNew) => {
				saved.push({ draft, saveAsNew });
			},
			onCancel: cancelled,
		},
		...overrides,
	});
	return { editor, saved, cancelled };
}

function typeText(editor: ProfileEditorComponent, value: string): void {
	for (const character of value) editor.handleInput(character);
}

describe("profile draft editor isolation", () => {
	test("keeps inherited fields read-only until inclusion and confirms destructive exclusion", () => {
		const effectiveSettings = Settings.isolated({ "compaction.enabled": false });
		const { editor } = createEditor({ effectiveSettings, initialGroup: "context" });

		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).not.toContain("context");
		expect(draftValue(editor.draft, "compaction.enabled")).toBeUndefined();

		editor.handleInput("\x1b[A");
		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).toContain("context");
		expect(cfgCompactionEnabled.get(effectiveSettings)).toBe(false);

		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).toContain("context");
		editor.handleInput(" ");
		expect(editor.draft.metadata.enabledGroups).not.toContain("context");
		for (const setting of getSetupGroupSettings("context")) {
			expect(draftValue(editor.draft, setting.id)).toBeUndefined();
		}
		expect(cfgCompactionEnabled.get(effectiveSettings)).toBe(false);
	});

	test("re-enabling a discarded group seeds the inherited base instead of the old profile overlay", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["context"];
		draft.config.compaction = { enabled: true };
		const { editor } = createEditor({
			draft,
			effectiveSettings: Settings.isolated({ "compaction.enabled": true }),
			inheritedSettings: Settings.isolated({ "compaction.enabled": false }),
			initialGroup: "context",
		});

		editor.handleInput(" ");
		editor.handleInput(" ");
		expect(editor.draft.metadata.enabledGroups).not.toContain("context");
		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).toContain("context");
		expect(draftValue(editor.draft, "compaction.enabled")).toBe(false);
	});

	test("edits a native field in the continuous list without entering a group page", () => {
		const effectiveSettings = Settings.isolated({ "compaction.enabled": false });
		const { editor } = createEditor({ effectiveSettings, initialGroup: "context" });
		editor.handleInput("\r");
		typeText(editor, "auto-compact");
		editor.handleInput("\r");

		expect(draftValue(editor.draft, "compaction.enabled")).toBe(true);
		expect(cfgCompactionEnabled.get(effectiveSettings)).toBe(false);
	});

	test("refreshes condition-gated fields after a native enum editor changes the draft", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["memory"];
		draft.config.memory = { backend: "off" };
		const effectiveSettings = Settings.isolated({ "memory.backend": "off" });
		const { editor } = createEditor({ draft, effectiveSettings, initialGroup: "memory" });

		typeText(editor, "memory backend");
		editor.handleInput("\r");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		typeText(editor, "hindsight auto recall");

		expect(draftValue(editor.draft, "memory.backend")).toBe("hindsight");
		expect(cfgMemoryBackend.get(effectiveSettings)).toBe("off");
		expect(editor.render(120).map(stripVTControlCharacters).join("\n")).toContain("Hindsight Auto Recall");
	});

	test("uses the native compound editor while keeping fallback changes draft-only", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["model"];
		draft.config.retry = { fallbackChains: {} };
		const effectiveSettings = Settings.isolated({ "retry.fallbackChains": {} });
		const { editor } = createEditor({ draft, effectiveSettings, initialGroup: "model" });

		typeText(editor, "retry fallback chains");
		editor.handleInput("\r");
		editor.handleInput("\x7f");
		editor.handleInput("\x7f");
		editor.handleInput('{"default":["openai/fallback"]}');
		editor.handleInput("\r");

		expect(draftValue(editor.draft, "retry.fallbackChains")).toEqual({ default: ["openai/fallback"] });
		expect(cfgRetryFallbackChains.get(effectiveSettings)).toEqual({});
	});

	test("field Escape returns to the flat editor before a later main-list Escape cancels the draft", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["model"];
		draft.config.retry = { fallbackChains: {} };
		const { editor, cancelled } = createEditor({ draft, initialGroup: "model" });

		typeText(editor, "retry fallback chains");
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		expect(cancelled).not.toHaveBeenCalled();
		editor.handleInput("\x1b");
		expect(cancelled).not.toHaveBeenCalled();
		editor.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	test("shows captured agent assignments and keeps the agents hub's edits in the draft", async () => {
		const draft = modelsOnlyDraft();
		draft.metadata.enabledGroups = ["tasks"];
		draft.config.task = {
			disabledAgents: ["scout"],
			agentModelOverrides: {
				reviewer: ["anthropic/first", "openai/second"],
			},
		};
		const opened: Array<string | undefined> = [];
		// The editor re-renders once it has applied the hub's result.
		const applied = Promise.withResolvers<void>();
		let hubClosed = false;
		const { editor } = createEditor({
			draft,
			agentNames: ["scout", "reviewer", "security-reviewer"],
			initialGroup: "tasks",
			callbacks: {
				requestRender: () => {
					if (hubClosed) applied.resolve();
				},
				onEditRole: async () => undefined,
				onEditAgents: async (current, agent) => {
					opened.push(agent);
					const next = structuredClone(current);
					next.config.task = { ...(next.config.task as object), disabledAgents: ["scout", "reviewer"] };
					hubClosed = true;
					return next;
				},
				onSave: () => {},
				onCancel: () => {},
			},
		});
		typeText(editor, "reviewer");
		const text = editor.render(120).map(stripVTControlCharacters).join("\n");
		expect(text).toContain("Agent · reviewer");
		expect(text).toContain("anthropic/first → openai/second");

		editor.handleInput("\r");
		await applied.promise;
		expect(opened).toEqual(["reviewer"]);
		expect(draftValue(editor.draft, "task.disabledAgents")).toEqual(["scout", "reviewer"]);
		expect(draftValue(editor.draft, "task.agentModelOverrides.reviewer")).toEqual([
			"anthropic/first",
			"openai/second",
		]);
	});

	test("Escape from the continuous main list cancels the entire staged draft", () => {
		const { editor, cancelled } = createEditor({ initialGroup: "context" });
		editor.handleInput("\r");
		expect(editor.draft.metadata.enabledGroups).toContain("context");
		editor.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	test("emoji picker Escape returns to the editor with the draft intact", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.emoji = "⚡";
		const { editor, cancelled } = createEditor({ draft });
		editor.handleInput("\r");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b");
		expect(cancelled).not.toHaveBeenCalled();
		expect(editor.draft.metadata.emoji).toBe("⚡");
		editor.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	test("Down crosses into model roles and a cancelled role picker keeps the draft open", async () => {
		const roles: string[] = [];
		const cancelled = vi.fn();
		const { editor } = createEditor({
			callbacks: {
				requestRender: () => {},
				onEditRole: async role => {
					roles.push(role);
					return undefined;
				},
				onSave: () => {},
				onCancel: cancelled,
				onEditAgents: async draft => draft,
			},
		});
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		await Promise.resolve();
		expect(roles).toEqual(["default"]);
		expect(cancelled).not.toHaveBeenCalled();
		expect(editor.draft.config.modelRoles).toEqual({ default: "anthropic/fixture-model" });
	});

	test("strips terminal controls from a resolver warning that quotes an imported selector", () => {
		using tempDir = TempDir.createSync("@omp-profile-editor-warning-");
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.keys.setRuntime("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const draft = modelsOnlyDraft();
			draft.config.modelRoles = { default: "anthropic/claude-sonnet-4-5:\x1b[2J" };
			const { editor } = createEditor({
				draft,
				callbacks: {
					requestRender: () => {},
					onEditRole: async (_role, current) => current,
					onEditAgents: async current => current,
					onSave: () => {},
					onCancel: () => {},
					roleWarnings: current => {
						const warnings = new Map<string, string>();
						const rows = projectProfileRoles({
							cwd: tempDir.path(),
							settings: Settings.isolated({ modelRoles: draftModelRoles(current) }),
							modelRegistry,
						});
						for (const row of rows) {
							if (row.warning) warnings.set(row.role, row.warning);
						}
						return warnings;
					},
				},
			});

			editor.handleInput("\x1b[B"); // Emoji → the imported default role, whose warning shows below the list.
			const frame = editor.render(160).join("\n");
			expect(frame).not.toContain("\x1b[2J");
			expect(stripVTControlCharacters(frame)).toContain("Invalid thinking level");
		} finally {
			authStorage.close();
		}
	});

	test("an emoji pick is staged in the draft and saved only with the draft", () => {
		const draft = modelsOnlyDraft();
		draft.metadata.emoji = "⚡";
		const { editor, saved } = createEditor({ draft });
		editor.handleInput("\r");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		expect(editor.draft.metadata.emoji).toBe("🪙");
		expect(saved).toEqual([]);
		editor.handleInput("\x13");
		expect(saved.map(entry => entry.draft.metadata.emoji)).toEqual(["🪙"]);
	});

	test("serializes immediate emoji saves and preserves the draft when a write fails", async () => {
		const draft = modelsOnlyDraft();
		draft.metadata.emoji = "⚡";
		const firstSave = Promise.withResolvers<boolean>();
		const secondSave = Promise.withResolvers<boolean>();
		const cancelled = vi.fn();
		let attempt = 0;
		const onSaveEmoji = vi.fn((_value: ProfileEmoji | undefined) => {
			attempt++;
			return attempt === 1 ? firstSave.promise : secondSave.promise;
		});
		const { editor } = createEditor({
			draft,
			callbacks: {
				requestRender: () => {},
				onEditRole: async (_role, current) => current,
				onEditAgents: async current => current,
				onSave: () => {},
				onSaveEmoji,
				onCancel: cancelled,
			},
		});

		editor.handleInput("\r");
		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		expect(onSaveEmoji).toHaveBeenCalledTimes(1);
		expect(onSaveEmoji).toHaveBeenLastCalledWith("🪙");
		expect(editor.draft.metadata.emoji).toBe("⚡");

		editor.handleInput("\x1b[B");
		editor.handleInput("\r");
		editor.handleInput("\x1b");
		expect(onSaveEmoji).toHaveBeenCalledTimes(1);
		expect(cancelled).not.toHaveBeenCalled();

		firstSave.reject(new Error("\x1b[31mwrite\tfailed\nunsafe\x1b[0m"));
		await firstSave.promise.catch(() => undefined);
		await Promise.resolve();
		expect(editor.draft.metadata.emoji).toBe("⚡");
		expect(editor.render(80).map(stripVTControlCharacters).join("\n")).toContain("write failed unsafe");

		editor.handleInput("\r");
		expect(onSaveEmoji).toHaveBeenCalledTimes(2);
		expect(onSaveEmoji).toHaveBeenLastCalledWith("🪙");
		secondSave.resolve(true);
		await secondSave.promise;
		await Promise.resolve();
		expect(editor.draft.metadata.emoji).toBe("🪙");

		editor.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	test("keeps a rejected save visible and accepts a later retry", async () => {
		const saved: ProfileDraft[] = [];
		let attempts = 0;
		const { editor } = createEditor({
			callbacks: {
				requestRender: () => {},
				onEditRole: async (_role, draft) => draft,
				onEditAgents: async draft => draft,
				onSave: draft => {
					attempts++;
					if (attempts === 1) throw new Error("disk\tfull");
					saved.push(draft);
				},
				onCancel: () => {},
			},
		});

		editor.handleInput("\x13");
		await Promise.resolve();
		expect(editor.render(120).map(stripVTControlCharacters).join("\n")).toContain("disk full");
		editor.handleInput("\x13");
		await Promise.resolve();
		expect(saved).toHaveLength(1);
	});

	test("supports save-as-new and the labelled export continuation", async () => {
		const fresh = createEditor();
		typeText(fresh.editor, "save as new");
		fresh.editor.handleInput("\r");
		await Promise.resolve();
		expect(fresh.saved).toEqual([{ draft: modelsOnlyDraft(), saveAsNew: true }]);

		const exported = createEditor({
			title: "Prepare profile export",
			saveLabel: "Continue to export",
			allowSaveAsNew: false,
		});
		typeText(exported.editor, "continue to export");
		exported.editor.handleInput("\r");
		await Promise.resolve();
		expect(exported.saved).toEqual([{ draft: modelsOnlyDraft(), saveAsNew: false }]);
	});
});

describe("profile emoji picker", () => {
	test("fits the width, previews the actual setup name, and returns only curated emoji", () => {
		const selections: Array<ProfileEmoji | undefined> = [];
		const picker = new ProfileEmojiPicker({
			name: "Local coding",
			terminalHeight: 40,
			requestRender: () => {},
			onSelect: value => selections.push(value),
			onCancel: () => {},
		});
		for (const width of [80, 16]) {
			for (const line of picker.render(width).map(stripVTControlCharacters)) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		expect(picker.render(80).map(stripVTControlCharacters).join("\n")).toContain("Local coding");

		const local = PROFILE_EMOJIS.findIndex(item => item.label === "Local");
		for (let index = 0; index <= local; index++) picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		expect(selections).toEqual([PROFILE_EMOJIS[local]!.emoji]);

		for (let index = 0; index <= local; index++) picker.handleInput("\x1b[A");
		picker.handleInput("\r");
		expect(selections).toEqual([PROFILE_EMOJIS[local]!.emoji, undefined]);
	});

	test("a click chooses the row drawn under the pointer, with or without an error line", async () => {
		const draft = modelsOnlyDraft();
		draft.metadata.emoji = "⚡";
		const saves: Array<ProfileEmoji | undefined> = [];
		let lastSave: Promise<boolean> = Promise.resolve(false);
		const { editor } = createEditor({
			draft,
			callbacks: {
				requestRender: () => {},
				onEditRole: async (_role, current) => current,
				onEditAgents: async current => current,
				onSave: () => {},
				onCancel: () => {},
				onSaveEmoji: value => {
					saves.push(value);
					lastSave = saves.length === 1 ? Promise.reject(new Error("disk full")) : Promise.resolve(true);
					return lastSave;
				},
			},
		});
		// The fullscreen overlay anchors the frame to the bottom of createEditor's 24-row terminal.
		const clickNone = async () => {
			const frame = editor.render(80).map(stripVTControlCharacters);
			const screenRow = 24 - frame.length + frame.findIndex(line => line.includes("None"));
			editor.handleInput(`\x1b[<0;5;${screenRow + 1}M`);
			await lastSave.catch(() => false);
			await Promise.resolve();
		};

		editor.handleInput("\r");
		await clickNone();
		expect(saves).toEqual([undefined]);
		expect(editor.draft.metadata.emoji).toBe("⚡");

		// The failed write adds an error line above the list.
		await clickNone();
		expect(saves).toEqual([undefined, undefined]);
		expect(editor.draft.metadata.emoji).toBeUndefined();
	});
});
