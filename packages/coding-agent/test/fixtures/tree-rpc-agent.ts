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
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

// Real RPC dispatch over the session file `argv[3]`, resumed under the test's temp root `argv[2]`;
// the model is a mock that no command here calls. Both arrive as argv so storage can never land in
// an inherited cwd such as the repo checkout.
const root = process.argv[2];
const sessionFile = process.argv[3];
if (!root || root.startsWith("-") || !sessionFile || sessionFile.startsWith("-")) {
	throw new Error("tree-rpc-agent: expected the temp root and the session file as the first two arguments");
}
process.chdir(root);
const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
const sessionManager = await SessionManager.open(sessionFile, path.dirname(sessionFile), new FileSessionStorage(), {
	suppressBreadcrumb: true,
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: createMockModel({ responses: [] }).stream,
});
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
});
await runRpcMode(session);
