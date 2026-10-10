// Runs a `when-healthy` return from a fallback whose tokenizer undercounts the
// prompt relative to the primary's. Spawned with NODE_ENV=production so the
// tokenizers use their real native encodings instead of the test byte estimate.
import { Agent, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tmp = TempDir.createSync("@when-healthy-tokenizer-domain-");
const auth = await AuthStorage.create(tmp.join("auth.db"));
auth.keys.setRuntime("anthropic", "test-key");
auth.keys.setRuntime("openai", "test-key");
const modelsPath = tmp.join("models.json");
await Bun.write(
	modelsPath,
	JSON.stringify({
		providers: {
			anthropic: { modelOverrides: { "claude-sonnet-4-5": { contextWindow: 3300 } } },
			openai: { modelOverrides: { "gpt-4o-mini": { contextWindow: 1_000_000 } } },
		},
	}),
);
const settings = Settings.isolated({
	"compaction.enabled": true,
	"compaction.asyncEnabled": false,
	"compaction.methodOrder": ["soft"],
	"compaction.keepRecentTokens": 100,
	"compaction.thresholdPercent": 80,
	"compaction.thresholdTokens": -1,
	"retry.fallbackRevertPolicy": "when-healthy",
	"retry.fallbackChains": { default: ["openai/gpt-4o-mini"] },
});
settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
const registry = new ModelRegistry(auth, modelsPath, { settings });
registry.authStorage.health.model = async () => ({ state: "healthy", accounts: [] });
const primary = registry.find("anthropic", "claude-sonnet-4-5");
const fallback = registry.find("openai", "gpt-4o-mini");
if (!primary || !fallback) throw new Error("Expected bundled anthropic and openai models");

// CJK text: o200k (fallback) counts it well under the primary's window, the
// primary's own tokenizer counts it over.
const text = "你好，世界。ありがとう、さようなら。".repeat(200);
const requests: string[] = [];
let compactions = 0;
const mock = createMockModel();
const streamFn = (...args: Parameters<typeof mock.stream>) => {
	requests.push(args[0].id);
	mock.push({ content: ["ok"] });
	return mock.stream(...args);
};
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: fallback, systemPrompt: ["Test"], tools: [], messages: [] },
	streamFn,
});
const session = new AgentSession({
	agent,
	settings,
	modelRegistry: registry,
	sessionManager: SessionManager.inMemory(),
	sideStreamFn: streamFn,
	initialRetryFallback: {
		role: "default",
		originalSelector: "anthropic/claude-sonnet-4-5",
		originalThinkingLevel: undefined,
		pinned: true,
	},
});
session.subscribe(event => {
	if (event.type === "auto_compaction_start") compactions++;
});
try {
	await session.prompt(text);
	await session.waitForIdle();
	process.stdout.write(
		JSON.stringify({
			primaryTextTokens: new Tokenizer(primary).countTokens(text, "strict"),
			fallbackTextTokens: new Tokenizer(fallback).countTokens(text, "strict"),
			requests,
			compactions,
		}),
	);
} finally {
	await session.dispose();
	auth.close();
	tmp.removeSync();
}
