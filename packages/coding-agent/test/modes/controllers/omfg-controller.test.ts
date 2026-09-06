import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { OmfgController } from "@oh-my-pi/pi-coding-agent/modes/controllers/omfg-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const PROJECT_OPTION = "This project (.omp/rules)";

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
