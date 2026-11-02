import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// Real RPC dispatch, session queues and extension input handlers; only the model response is scripted.
// Input handler contract, keyed by message prefix:
//   "consume:"   -> handled, never reaches the agent
//   "transform:" -> replaced with untrimmed text
//   "slow:"      -> unchanged, after many I/O round trips so a later submission would overtake it if unordered
// Session switches take the same detour, so a frame sent right after `new_session` is read before it commits.
async function ioDetour(): Promise<void> {
	for (let index = 0; index < 50; index++) await Bun.file(import.meta.path).text();
}
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const sessionManager = SessionManager.inMemory(process.cwd());
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.on("input", async event => {
			if (event.source !== "rpc") throw new Error(`unexpected input source ${event.source}`);
			if (event.text.startsWith("consume:")) return { handled: true };
			if (event.text.startsWith("transform:")) return { text: "  transformed by hook\n" };
			if (event.text.startsWith("slow:")) await ioDetour();
			return undefined;
		});
		pi.on("session_before_switch", async () => {
			await ioDetour();
			return undefined;
		});
	},
	process.cwd(),
	new EventBus(),
	runtime,
	"input-hook",
);
const extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
const mock = createMockModel({ handler: { content: ["ok"] } });
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
	extensionRunner,
});
await runRpcMode(session);
