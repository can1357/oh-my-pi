import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
// Suite files that boot main() in ACP/RPC mode leave PI_NO_TITLE=1 behind, which gates titling off.
let previousNoTitle: string | undefined;

beforeEach(() => {
	previousNoTitle = Bun.env.PI_NO_TITLE;
	delete Bun.env.PI_NO_TITLE;
});

afterEach(async () => {
	if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
	else Bun.env.PI_NO_TITLE = previousNoTitle;
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

/**
 * How the fleet launches an agent: `omp "@brief.md"` sends the brief as one
 * `<file>` attachment. `cleanTinyMessage` strips the XML envelope, so the whole
 * request cleans away to nothing and no title model ever sees it.
 */
const ATTACHED_BRIEF = `<file name="/mnt/briefs/shellport-audit.md">
You are the ShellPortAudit lane. You own seven pull requests that were out of draft and are now
unmergeable, because upstream main deleted the vendored brush crates and rewrote the builtins.
Rebase each one onto live main, resolve the conflicts, re-run the shell suite and report.
</file>`;

/** A second launcher brief, for the operator who sends one while the first one's retry runs. */
const ATTACHED_FOLLOW_UP = `<file name="/mnt/briefs/shellport-audit-2.md">
Correction to the brief: #17858 is already merged, so drop it and take the remaining six. Report
to the lead once the shell suite is green on each one.
</file>`;

/** A reply of at least DEFERRED_TITLE_MIN_WORDS (40) words, which is what arms the deferred retitle. */
const AUDIT_REPLY =
	"Starting on the ShellPortAudit lane. Seven pull requests need rebasing onto live main after the vendored brush crates were deleted, so each one's conflicts have to be resolved against the new builtins before the shell suite can run again. I will take them oldest first and report once the suite is green.";

/** The title fork declines, so every title in this file comes from the title model. */
const declineTitleFork = createMockModel({ handler: { content: ["<title/>"] } }).stream;

/** Plain titles: a card request would double every title-model call and hide the bound under test. */
const PLAIN_TITLES = { "title.icons": "boring" };

function stepTool(): AgentTool {
	return {
		name: "step",
		label: "Step",
		description: "One unit of work",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

async function createSession(
	main: MockModel,
	tools: AgentTool[] = [],
	settings: Record<string, unknown> = {},
): Promise<AgentSession> {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
			streamFn: main.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			// One title model, so a failed attempt is one call rather than a chain walk.
			"retry.modelFallback": false,
			modelRoles: { tiny: `${model.provider}/${model.id}` },
			...PLAIN_TITLES,
			...settings,
		}),
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		sideStreamFn: declineTitleFork,
		autoTitle: true,
	});
	return session;
}

/** Resolves on the session's next title change. */
function nextTitle(target: AgentSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = target.sessionManager.onSessionNameChanged(() => {
		unsubscribe();
		resolve();
	});
	return promise;
}

/** The text a title request carries. */
function titleRequestInput(context: ai.Context): string {
	const content = context.messages[0]?.content;
	return typeof content === "string" ? content : "";
}

describe("AgentSession titles a session whose operator message cannot be titled", () => {
	it("names the session from the assistant's reading when the only operator message is an attached brief", async () => {
		const main = createMockModel({ responses: [{ content: [AUDIT_REPLY] }] });
		const target = await createSession(main);
		const titleInputs: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
			titleInputs.push(titleRequestInput(context));
			return createAssistantMessage("<title>Rebase the ShellPortAudit pull requests</title>");
		});
		const titled = nextTitle(target);

		await target.prompt(ATTACHED_BRIEF);
		await titled;

		expect(target.sessionName).toBe("Rebase the ShellPortAudit pull requests");
		// One request, and it names the conversation rather than the stripped brief.
		expect(titleInputs).toHaveLength(1);
		expect(titleInputs[0]).toContain("ShellPortAudit");
	});

	it("asks the title model once per operator message, however many assistant turns follow", async () => {
		// The bound: assistant turns never drive title requests. Five turns, one request.
		const toolCall = { type: "toolCall" as const, name: "step", arguments: {} };
		const main = createMockModel({
			responses: [
				{ content: [AUDIT_REPLY, toolCall] },
				{ content: [AUDIT_REPLY, toolCall] },
				{ content: [AUDIT_REPLY, toolCall] },
				{ content: [AUDIT_REPLY, toolCall] },
				{ content: [AUDIT_REPLY] },
			],
		});
		const target = await createSession(main, [stepTool()]);
		// The title model declines, so no title is set and nothing stops a runaway retry.
		const titleModel = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("<title/>"));

		await target.prompt(ATTACHED_BRIEF);
		await target.waitForIdle();

		expect(main.calls.length).toBe(5);
		expect(target.sessionName).toBeUndefined();
		expect(titleModel).toHaveBeenCalledTimes(1);
	});

	it("keeps a running request's retry when an untitleable message lands while it is still in flight", async () => {
		// The deferral a titleable message armed has already seen its reply; a "hm"
		// typed before that request settles must not replace it, because the
		// replacement cannot run while the first request is still in flight.
		const main = createMockModel({
			responses: [{ content: [AUDIT_REPLY] }, { content: [AUDIT_REPLY] }],
		});
		const target = await createSession(main, [], { "title.generator": "tiny" });
		const firstRequest = Promise.withResolvers<ai.AssistantMessage>();
		let calls = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			calls++;
			if (calls === 1) return firstRequest.promise;
			return Promise.resolve(createAssistantMessage("<title>Rebase the ShellPortAudit pull requests</title>"));
		});

		await target.prompt("rebase the seven ShellPortAudit pull requests onto live main");
		expect(calls).toBe(1);
		await target.prompt(ATTACHED_BRIEF);

		const titled = nextTitle(target);
		firstRequest.resolve(createAssistantMessage("<title/>"));
		await titled;

		expect(target.sessionName).toBe("Rebase the ShellPortAudit pull requests");
		expect(calls).toBe(2);
	});

	it("names the session from a brief that arrives while the previous retry is still running", async () => {
		// The retry consumed its deferral when it started, so the follow-up brief
		// arms one of its own; it is ready before the running request settles, and
		// must wait for it rather than be spent on a request that cannot start.
		const main = createMockModel({
			responses: [{ content: [AUDIT_REPLY] }, { content: [AUDIT_REPLY] }],
		});
		const target = await createSession(main, [], { "title.generator": "tiny" });
		const firstRetry = Promise.withResolvers<ai.AssistantMessage>();
		let calls = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			calls++;
			if (calls === 1) return firstRetry.promise;
			return Promise.resolve(createAssistantMessage("<title>Rebase the ShellPortAudit pull requests</title>"));
		});

		await target.prompt(ATTACHED_BRIEF);
		expect(calls).toBe(1);
		await target.prompt(ATTACHED_FOLLOW_UP);

		const titled = nextTitle(target);
		firstRetry.resolve(createAssistantMessage("<title/>"));
		await titled;

		expect(target.sessionName).toBe("Rebase the ShellPortAudit pull requests");
		expect(calls).toBe(2);
	});
});
