import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC dispatch over a session persisted under the test's temp root; only model replies are scripted.
// The root arrives as argv so storage can never land in an inherited cwd such as the repo checkout.
const root = process.argv[2];
if (!root || root.startsWith("-")) throw new Error("fork-rpc-agent: expected the temp root as the first argument");
process.chdir(root);
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const askQuestions = [{ id: "target", question: "Where?", options: [{ label: "staging" }, { label: "prod" }] }];
const mock = createMockModel({
	// A prompt mentioning "slow" announces with a notice that its model call is in flight, then
	// streams until the test aborts it.
	// "seed-ask" calls `ask` (not registered here, so it records an error result) with questions
	// a picker could reopen; "seed-bad-ask" calls it with arguments no picker could use.
	handler: context => {
		const last = JSON.stringify(context.messages.at(-1)?.content);
		if (last.includes("seed-ask") || last.includes("seed-bad-ask")) {
			const args = last.includes("seed-ask") ? { questions: askQuestions } : {};
			return { content: [{ type: "toolCall", id: "ask-1", name: "ask", arguments: args }] };
		}
		if (!last.includes("slow")) return { content: ["Done"] };
		session.emitNotice("info", "slow turn streaming", "fork-rpc-agent");
		// The delay only bounds a leaked process; the test aborts the turn.
		return { content: ["Done"], delayMs: 600_000 };
	},
});
// The first goal continuation waits here until a branch summary starts, so it is decided but not yet started.
const summaryStarted = Promise.withResolvers<void>();
// Settles once a user bash command is running (the runner registers it synchronously).
const bashStarted = Promise.withResolvers<void>();
// Branch summaries: one whose instructions say "hang-summary" announces itself with a notice and runs
// until aborted; "bash-summary" announces itself and answers once a user bash command is running;
// any other releases the held continuation and answers once that continuation has been decided.
const side = createMockModel({
	handler: async context => {
		summaryStarted.resolve();
		const prompt = JSON.stringify(context.messages);
		if (prompt.includes("hang-summary") || prompt.includes("bash-summary")) {
			session.emitNotice("info", "summary started", "fork-rpc-agent");
		}
		if (prompt.includes("hang-summary")) return { content: ["unreachable"], delayMs: 600_000 };
		if (prompt.includes("bash-summary")) await bashStarted.promise;
		// The released continuation decides within microtasks; one macrotask turn runs them all.
		else if (heldGoalIdle) {
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
		}
		return { content: ["Branch summary"] };
	},
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.create(cwd, path.join(cwd, "sessions")),
	settings: Settings.isolated({ "compaction.enabled": false, "goal.continuationModes": ["rpc"] }),
	modelRegistry,
	sideStreamFn: side.stream,
});
const executeBash = session.executeBash.bind(session);
session.executeBash = (...args) => {
	const result = executeBash(...args);
	bashStarted.resolve();
	return result;
};
const waitForIdle = session.waitForIdle.bind(session);
let heldGoalIdle = false;
session.waitForIdle = async () => {
	await waitForIdle();
	if (heldGoalIdle || !session.getGoalModeState()?.enabled) return;
	heldGoalIdle = true;
	await summaryStarted.promise;
};
await runRpcMode(session);
