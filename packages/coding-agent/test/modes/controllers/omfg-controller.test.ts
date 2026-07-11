import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AssistantMessage, Usage } from "@pk-nerdsaver-ai/pi-ai";
import type { Rule } from "@pk-nerdsaver-ai/pi-coding-agent/capability/rule";
import { OmfgController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/omfg-controller";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { Container, type TUI } from "@pk-nerdsaver-ai/pi-tui";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const PROJECT_OPTION = "This project (.omp/rules)";
const GLOBAL_OPTION = "Global — all projects (~/.omp/agent/rules)";
const AMEND_OPTION = "Amend with feedback…";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface RunEphemeralTurnArgs {
	promptText: string;
	dedupeReply?: boolean;
	onTextDelta?: (delta: string) => void;
	signal?: AbortSignal;
}

interface RunEphemeralTurnResult {
	replyText: string;
	assistantMessage: AssistantMessage;
}

type RunEphemeralTurn = (args: RunEphemeralTurnArgs) => Promise<RunEphemeralTurnResult>;
type AddRule = (rule: Rule) => boolean;
type ShowHookSelector = (title: string, options: string[]) => Promise<string | undefined>;
type ShowHookConfirm = (title: string, message: string) => Promise<boolean>;
type ShowHookInput = (title: string, placeholder?: string) => Promise<string | undefined>;

interface HarnessOptions {
	runEphemeralTurn: RunEphemeralTurn;
	messages?: AgentMessage[];
	hasModel?: boolean;
	selectorChoice?: string | undefined;
	selectorChoices?: Array<string | undefined>;
	inputChoice?: string | undefined;
	confirmResult?: boolean;
}

interface Harness {
	ctx: InteractiveModeContext;
	container: Container;
	projectDir: string;
	agentDir: string;
	ttsrAddRule: Mock<AddRule>;
	showHookSelector: Mock<ShowHookSelector>;
	showHookConfirm: Mock<ShowHookConfirm>;
	showHookInput: Mock<ShowHookInput>;
}

const tempRoots: string[] = [];

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createRule(name: string, condition: string, scope: string): string {
	return JSON.stringify({
		name,
		description: "Generated rule",
		condition,
		scope,
		body: "Use the safer behavior.",
	});
}

function expectedRuleMarkdown(name: string, condition: string, scope: string): string {
	return [
		"---",
		`name: ${name}`,
		'description: "Generated rule"',
		`condition: ${JSON.stringify(condition)}`,
		`scope: ${JSON.stringify(scope)}`,
		"---",
		"",
		"Use the safer behavior.",
	].join("\n");
}

function createMatchingMessages(): AgentMessage[] {
	return [
		createAssistantMessage([
			{
				type: "toolCall",
				id: "call-1",
				name: "edit",
				arguments: { path: "src/example.ts", content: "const value: any = input;" },
			},
		]),
	];
}

async function createHarness(options: HarnessOptions): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omfg-controller-"));
	tempRoots.push(root);
	const projectDir = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(projectDir, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });

	const ttsrAddRule = vi.fn<AddRule>(() => true);
	const selectorChoices = [...(options.selectorChoices ?? [options.selectorChoice ?? PROJECT_OPTION])];
	const showHookSelector = vi.fn<ShowHookSelector>(async () => selectorChoices.shift());
	const showHookConfirm = vi.fn<ShowHookConfirm>(async () => options.confirmResult ?? true);
	const showHookInput = vi.fn<ShowHookInput>(async () => options.inputChoice);
	const session = {
		model: options.hasModel === false ? undefined : { provider: "anthropic", id: "claude-sonnet-4-5" },
		runEphemeralTurn: options.runEphemeralTurn,
		messages: options.messages ?? [],
		ttsrManager: { addRule: ttsrAddRule },
	} as unknown as InteractiveModeContext["session"];
	const container = new Container();
	const ctx = {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		omfgContainer: container,
		session,
		sessionManager: { getCwd: () => projectDir } as unknown as InteractiveModeContext["sessionManager"],
		settings: { getAgentDir: () => agentDir } as unknown as InteractiveModeContext["settings"],
		showStatus: vi.fn(),
		showError: vi.fn(),
		showHookInput,
		showHookSelector,
		showHookConfirm,
	} as unknown as InteractiveModeContext;
	return { ctx, container, projectDir, agentDir, ttsrAddRule, showHookSelector, showHookConfirm, showHookInput };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 1_000; i++) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	expect(predicate()).toBe(true);
}

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	vi.restoreAllMocks();
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			await removeWithRetries(root);
		}
	}
});

describe("OmfgController", () => {
	it("saves a matching generated rule under project rules and registers it live", async () => {
		const reply = createRule("ts-no-any", ": any|as any", "tool:edit(*.ts)");
		const runEphemeralTurn = vi.fn<RunEphemeralTurn>(async args => {
			expect(args.dedupeReply).toBe(false);
			args.onTextDelta?.(reply);
			return { replyText: reply, assistantMessage: createAssistantMessage([{ type: "text", text: reply }]) };
		});
		const harness = await createHarness({ runEphemeralTurn, messages: createMatchingMessages() });
		const controller = new OmfgController(harness.ctx);

		await controller.start("This guy used any again");
		const savedPath = path.join(harness.projectDir, ".omp", "rules", "ts-no-any.md");
		await waitFor(() => harness.ttsrAddRule.mock.calls.length === 1);

		expect(await Bun.file(savedPath).text()).toBe(
			expectedRuleMarkdown("ts-no-any", ": any|as any", "tool:edit(*.ts)"),
		);
		expect(harness.showHookSelector.mock.calls[0]).toEqual([
			"Save TTSR rule where?",
			[PROJECT_OPTION, GLOBAL_OPTION, AMEND_OPTION],
		]);
		expect(harness.ttsrAddRule.mock.calls[0]?.[0].path).toBe(savedPath);
		const rendered = Bun.stripANSI(harness.container.render(120).join("\n"));
		expect(rendered).toContain("Registered live");
		expect(rendered).toContain(path.join(".omp", "rules", "ts-no-any.md"));
		expect(rendered).toContain("Esc dismiss");
		expect(controller.hasActiveRequest()).toBe(true);
		expect(controller.handleEscape()).toBe(true);
		expect(harness.container.children).toHaveLength(0);
		expect(controller.hasActiveRequest()).toBe(false);
	});

	it("reiterates when the first valid rule does not match history", async () => {
		const firstReply = createRule("wrong-pattern", "never-happened", "text");
		const secondReply = createRule("ts-no-any", ": any|as any", "tool:edit(*.ts)");
		const runEphemeralTurn = vi
			.fn<RunEphemeralTurn>()
			.mockResolvedValueOnce({
				replyText: firstReply,
				assistantMessage: createAssistantMessage([{ type: "text", text: firstReply }]),
			})
			.mockResolvedValueOnce({
				replyText: secondReply,
				assistantMessage: createAssistantMessage([{ type: "text", text: secondReply }]),
			});
		const harness = await createHarness({ runEphemeralTurn, messages: createMatchingMessages() });
		const controller = new OmfgController(harness.ctx);

		await controller.start("Stop using any");
		await waitFor(() => runEphemeralTurn.mock.calls.length === 2 && harness.ttsrAddRule.mock.calls.length === 1);

		expect(runEphemeralTurn.mock.calls[1]?.[0].promptText).toContain(
			"No assistant history surface matched condition",
		);
		expect(await Bun.file(path.join(harness.projectDir, ".omp", "rules", "ts-no-any.md")).exists()).toBe(true);
	});

	it("asks before saving when validation never confirms a match", async () => {
		const reply = createRule("no-match", "never-happened", "text");
		const runEphemeralTurn = vi.fn<RunEphemeralTurn>(async () => ({
			replyText: reply,
			assistantMessage: createAssistantMessage([{ type: "text", text: reply }]),
		}));
		const harness = await createHarness({
			runEphemeralTurn,
			messages: [createAssistantMessage([{ type: "text", text: "Nothing matching." }])],
			confirmResult: false,
		});
		const controller = new OmfgController(harness.ctx);

		await controller.start("Catch it next time");
		await waitFor(() => harness.showHookConfirm.mock.calls.length === 1);

		expect(runEphemeralTurn).toHaveBeenCalledTimes(3);
		expect(harness.showHookConfirm.mock.calls[0]?.[0]).toBe("Validation");
		expect(harness.showHookSelector).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(harness.projectDir, ".omp", "rules", "no-match.md")).exists()).toBe(false);
	});

	it("lets the user amend from the save selector before writing the rule", async () => {
		const firstReply = createRule("ts-any-broad", ": any|as any", "tool:edit(*.ts)");
		const secondReply = createRule("ts-no-explicit-any", ": any|as any", "tool:edit(*.ts)");
		const runEphemeralTurn = vi
			.fn<RunEphemeralTurn>()
			.mockResolvedValueOnce({
				replyText: firstReply,
				assistantMessage: createAssistantMessage([{ type: "text", text: firstReply }]),
			})
			.mockResolvedValueOnce({
				replyText: secondReply,
				assistantMessage: createAssistantMessage([{ type: "text", text: secondReply }]),
			});
		const harness = await createHarness({
			runEphemeralTurn,
			messages: createMatchingMessages(),
			selectorChoices: [AMEND_OPTION, PROJECT_OPTION],
			inputChoice: "Rename it and make the guidance stricter before saving.",
		});
		const controller = new OmfgController(harness.ctx);

		await controller.start("Stop using any");
		await waitFor(() => runEphemeralTurn.mock.calls.length === 2 && harness.ttsrAddRule.mock.calls.length === 1);

		expect(harness.showHookInput).toHaveBeenCalledWith(
			"Amend TTSR rule",
			"e.g. Make it specific to Ruby string eval in tool:write(*.rb)",
		);
		expect(runEphemeralTurn.mock.calls[1]?.[0].promptText).toContain("User requested this amendment before saving:");
		expect(runEphemeralTurn.mock.calls[1]?.[0].promptText).toContain(
			"Rename it and make the guidance stricter before saving.",
		);
		expect(await Bun.file(path.join(harness.projectDir, ".omp", "rules", "ts-any-broad.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(harness.projectDir, ".omp", "rules", "ts-no-explicit-any.md")).exists()).toBe(
			true,
		);
	});

	it("guards empty complaints and missing models before model calls", async () => {
		const runEphemeralTurn = vi.fn<RunEphemeralTurn>(async () => ({
			replyText: "n/a",
			assistantMessage: createAssistantMessage([{ type: "text", text: "n/a" }]),
		}));
		const emptyHarness = await createHarness({ runEphemeralTurn });
		await new OmfgController(emptyHarness.ctx).start("   ");
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(emptyHarness.ctx.showStatus).toHaveBeenCalledWith("Usage: /omfg <complaint>");

		const missingModelHarness = await createHarness({ runEphemeralTurn, hasModel: false });
		await new OmfgController(missingModelHarness.ctx).start("anything");
		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(missingModelHarness.ctx.showError).toHaveBeenCalledWith("No active model available for /omfg.");
	});

	it("clears the panel and aborts the inner request on Escape", async () => {
		let signal: AbortSignal | undefined;
		const runEphemeralTurn = vi.fn<RunEphemeralTurn>(async args => {
			signal = args.signal;
			return Promise.withResolvers<RunEphemeralTurnResult>().promise;
		});
		const harness = await createHarness({ runEphemeralTurn, messages: createMatchingMessages() });
		const controller = new OmfgController(harness.ctx);

		await controller.start("stop this");

		expect(harness.container.children).toHaveLength(1);
		expect(controller.handleEscape()).toBe(true);
		expect(harness.container.children).toHaveLength(0);
		expect(signal?.aborted).toBe(true);
		expect(controller.hasActiveRequest()).toBe(false);
		expect(await Bun.file(path.join(harness.projectDir, ".omp", "rules", "ts-no-any.md")).exists()).toBe(false);
	});
});
