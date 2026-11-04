/**
 * API Keys and OAuth
 *
 * Configure API key resolution via AuthStorage and ModelRegistry.
 */
import {
	AuthStorage,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
} from "@oh-my-pi/pi-coding-agent";

// Default: discoverAuthStorage() uses ~/.omp/agent/agent.db, and the registry
// loads built-in + custom models from ~/.omp/agent/models.yml
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with default auth storage and model registry");

// Custom auth storage location
const customAuthStorage = await AuthStorage.create("/tmp/my-app/agent.db");
const customModelRegistry = new ModelRegistry(customAuthStorage, "/tmp/my-app/models.yml");
await customModelRegistry.refresh();

await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage: customAuthStorage,
	modelRegistry: customModelRegistry,
});
console.log("Session with custom auth storage location");

// Runtime API key override (not persisted to disk)
authStorage.keys.setRuntime("anthropic", "sk-my-temp-key");
await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry,
});
console.log("Session with runtime API key override");

// Ignore models.yml - only built-in models
const simpleRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
await simpleRegistry.refresh();
await createAgentSession({
	sessionManager: SessionManager.inMemory(),
	authStorage,
	modelRegistry: simpleRegistry,
});
console.log("Session with only built-in models");
