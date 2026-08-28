import { Database } from "bun:sqlite";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

/**
 * Shared factory for building a minimal mock `AssistantMessage`
 * used by AgentSession test suites.
 */
export function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Build isolated auth state without opening a filesystem-backed SQLite database.
 * AgentSession unit tests that only need a runtime API key should not pay for
 * database creation, journaling, and deletion on every case.
 */
export function createInMemoryAuthStorage(): AuthStorage {
	return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
}
