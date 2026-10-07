import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Real RPC session whose skills are rediscovered from the cwd's `.omp/skills` only, so a
// test can install a SKILL.md after startup and drive `refresh_commands` against it.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("zai", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const mock = createMockModel({ handler: { content: ["ok"] } });
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("zai", "glm-5.3"), systemPrompt: ["Test"], tools: [], messages: [] },
	convertToLlm,
	streamFn: mock.stream,
});
const settings = Settings.isolated({
	"compaction.enabled": false,
	"skills.enabled": true,
	"skills.enableSkillCommands": true,
	"skills.enableCodexUser": false,
	"skills.enableClaudeUser": false,
	"skills.enableClaudeProject": false,
	"skills.enablePiUser": false,
	"skills.enablePiProject": true,
	"skills.enableAgentsUser": false,
	"skills.enableAgentsProject": false,
});
// Registers the capability providers (importing `discovery`) and binds this session's switches.
initializeWithSettings(settings);
const session = new AgentSession({
	agent,
	sessionManager: SessionManager.inMemory(cwd),
	settings,
	modelRegistry,
	toolRegistry: new Map(),
	skills: [],
	skillsSettings: { enableSkillCommands: true },
});
await runRpcMode(session);
