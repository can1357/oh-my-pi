import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgComposerTokenRate } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TspKind } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";

const context = (supports: (kind: TspKind) => boolean): DescribeContext => ({
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports,
	feature: () => true,
});
const cx = context(() => true);

const PLAN: TodoPhase[] = [
	{ name: "Notifications", tasks: [{ content: "Add new-mail alerts", status: "in_progress" }] },
];

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function nodes(root: NativeNode): NativeNode[] {
	const out: NativeNode[] = [root];
	for (const child of root.c ?? []) if (isNode(child)) out.push(...nodes(child));
	return out;
}

function role(n: NativeNode): string | undefined {
	return n.p !== undefined && "role" in n.p ? n.p.role : undefined;
}

describe("InteractiveMode native dock activity line", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-activity-line-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(() => {
		mode.loadingAnimation?.stop();
		mode.loadingAnimation = undefined;
		mode.statusContainer.disposeChildren();
		mode.setTodos([]);
		session.tokenRate.reset();
		cfgComposerTokenRate.clearOverride(settings);
	});

	afterAll(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	const activity = (describeCx = cx) => mode.statusContainer.describe(describeCx)!;
	const keys = (root: NativeNode) => (root.c ?? []).filter(isNode).map(n => n.key);

	it("describes nothing when no status row runs and there is no plan", () => {
		expect(activity()).toEqual({ k: "col", p: undefined, c: [], key: undefined });
	});

	it("holds the todo in the activity line, not the HUD pills row, between turns", () => {
		mode.setTodos(PLAN);
		const line = activity();
		expect(role(line)).toBe("omp.hud.activity");
		expect(keys(line)).toEqual(["todo"]);
		const todo = (line.c ?? []).filter(isNode)[0]!;
		expect(todo).toMatchObject({ k: "checklist", p: { mode: "hud", role: "omp.hud.todo" } });
		expect(mode.describeHudPills()).toMatchObject({ p: { hidden: true }, c: [] });

		// A terminal without `checklist` gets the phase tree in the same slot.
		const fallback = (activity(context(kind => kind !== "checklist")).c ?? []).filter(isNode)[0]!;
		expect(fallback).toMatchObject({ k: "col", key: "todo", p: { role: "omp.hud.todo" } });
		expect(nodes(fallback).some(n => n.k === "tree")).toBe(true);
	});

	it("puts the working row before the todo while a turn runs, and the status alone without a plan", () => {
		mode.ensureLoadingAnimation();
		const statusOnly = activity();
		expect(keys(statusOnly)).toEqual(["status"]);
		const status = (statusOnly.c ?? []).filter(isNode)[0]!;
		expect(role(status)).toBe("omp.hud.status");
		expect(status.c).toEqual([mode.loadingAnimation!]);

		mode.setTodos(PLAN);
		expect(keys(activity())).toEqual(["status", "todo"]);
	});

	it("shows tok/s in the composer bar only with the setting on and a reading", () => {
		const rate = () => nodes(mode.editor.describe(cx)).find(n => role(n) === "omp.composer.rate");
		session.tokenRate.seed(1_000, 10_000);
		expect(rate()).toBeUndefined();

		cfgComposerTokenRate.override(settings, true);
		expect(rate()?.p).toMatchObject({ value: 100, unit: "tok/s" });

		session.tokenRate.reset();
		expect(rate()).toBeUndefined();
	});
});
