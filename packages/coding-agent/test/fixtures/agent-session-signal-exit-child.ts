import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionTeardown } from "@oh-my-pi/pi-coding-agent/modes/session-teardown";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { postmortem } from "@oh-my-pi/pi-utils";

const directory = process.argv[2];
if (!directory) throw new Error("Expected session directory");
// "host-before-session" registers the host's teardown before the session exists, as ACP does for
// the sessions a client asks for: postmortem runs registrations newest first, so the session's own
// exit recorder then runs before the host begins disposal.
const order = process.argv[3] ?? "host-after-session";
// How the process ends once ready: "sigterm" waits for the parent's signal; "manual" runs the manual
// cleanup pass that quit and relaunch run, then exits; "exit" starts the host's teardown and calls
// process.exit() while its disposal drains.
const ending = process.argv[4] ?? "sigterm";
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled test model");
const authStorage = await AuthStorage.create(path.join(directory, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(directory, "models.yml"));
const manager = SessionManager.create(directory, directory);
const mock = createMockModel({
	responses: [{ content: ["first answer"] }, { content: ["never delivered"], delayMs: 600_000 }],
});
let requestCount = 0;
const secondRequest = Promise.withResolvers<void>();
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	convertToLlm,
	streamFn: (requestModel, context, options) => {
		if (++requestCount === 2) secondRequest.resolve();
		return mock.stream(requestModel, context, options);
	},
});
// The teardown may be registered before the session exists, so it reaches the session through this holder.
const host: { session?: AgentSession } = {};
const teardown = createSessionTeardown({
	getDraftText: () => "",
	beginDispose: () => host.session?.beginDispose(),
	saveDraft: async () => {},
	disposeSession: async reason => {
		await host.session?.dispose({ reason });
	},
});
if (order === "host-before-session") postmortem.register("session-teardown", teardown);
const session = new AgentSession({
	agent,
	sessionManager: manager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});
host.session = session;
if (order === "host-after-session") postmortem.register("session-teardown", teardown);
postmortem.installProcessHandlers();

await session.prompt("answer one");
const pending = session.prompt("held second answer").catch(() => undefined);
await secondRequest.promise;
await session.followUp("accepted before exit");
process.stdout.write(`${JSON.stringify({ ready: true, sessionFile: manager.getSessionFile() })}\n`);
if (ending === "manual") {
	await postmortem.cleanup();
	await pending;
	process.exit(0);
}
if (ending === "exit") {
	void teardown();
	process.exit(0);
}
await pending;
