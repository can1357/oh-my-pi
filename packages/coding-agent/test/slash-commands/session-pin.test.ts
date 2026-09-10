import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// builtin-session ↔ builtin-modes ↔ model-registry form a latent import cycle
// (present on main) that only initializes cleanly when builtin-registry is the
// entry point — the shape every other slash-command test uses. Importing it
// first keeps this file's direct builtin-session import from hitting a TDZ
// error when the file runs standalone.
import "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "../../src/session/auth-storage";
import type { AgentSession } from "../../src/session/agent-session";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "../../src/slash-commands/builtin-session";
import { parseSlashCommand } from "../../src/slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const PROVIDER = "unit-session-pin-cmd";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

/** AgentSession stub whose pin surface is backed by a real AuthStorage. */
function stubSession(authStorage: AuthStorage, sessionId: string): AgentSession {
	const stub = {
		isStreaming: false,
		sessionId,
		modelRegistry: { authStorage },
		listCurrentProviderOAuthAccounts: () =>
			Promise.resolve({ provider: PROVIDER, accounts: authStorage.listOAuthAccounts(PROVIDER, sessionId) }),
		pinCurrentProviderOAuthAccount: (credentialId: number, options?: { exclusive?: boolean }) =>
			authStorage.pinSessionOAuthAccount(PROVIDER, sessionId, credentialId, options),
		unpinCurrentProviderOAuthAccount: () => authStorage.unpinSessionOAuthAccount(PROVIDER, sessionId),
	};
	return stub as unknown as AgentSession;
}

const sessionSpec = BUILTIN_SESSION_SLASH_COMMANDS.find(spec => spec.name === "session");

/** Drive the session command's text-mode (ACP) handler, capturing its output lines. */
async function runSessionCommand(session: AgentSession, text: string): Promise<string> {
	if (!sessionSpec?.handle) throw new Error("session command has no text-mode handler");
	const parsed = parseSlashCommand(text);
	if (!parsed) throw new Error(`not a slash command: ${text}`);
	const lines: string[] = [];
	const runtime = {
		session,
		output: (output: string) => {
			lines.push(output);
		},
		refreshCommands: () => {},
		reloadPlugins: () => Promise.resolve(),
	} as unknown as SlashCommandRuntime;
	await sessionSpec.handle(parsed, runtime);
	return lines.join("\n");
}

describe("/session pin --exclusive", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-session-pin-cmd-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		await authStorage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	function storage(): AuthStorage {
		if (!authStorage) throw new Error("test setup failed");
		return authStorage;
	}

	it("lists accounts and documents --exclusive and /session unpin", async () => {
		const text = await runSessionCommand(stubSession(storage(), "session-a"), "/session pin");
		expect(text).toContain("1. a@example.com");
		expect(text).toContain("2. b@example.com");
		expect(text).toContain("--exclusive");
		expect(text).toContain("/session unpin");
	});

	it("pins exclusively and marks the account as held in other sessions' listings", async () => {
		const pinResult = await runSessionCommand(stubSession(storage(), "session-a"), "/session pin 2 --exclusive");
		expect(pinResult).toContain("Pinned b@example.com exclusively");
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-a")).toBe(true);

		const listing = await runSessionCommand(stubSession(storage(), "session-b"), "/session pin");
		expect(listing).toContain("2. b@example.com (exclusive to another session)");
	});

	it("refuses an exclusive pin already held by another session", async () => {
		await runSessionCommand(stubSession(storage(), "session-a"), "/session pin 2 --exclusive");

		const result = await runSessionCommand(stubSession(storage(), "session-b"), "/session pin 2 --exclusive");
		expect(result).toContain("b@example.com is exclusively pinned by another session");
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-b")).toBe(false);
	});

	it("releases the hold with /session unpin so another session can take it", async () => {
		await runSessionCommand(stubSession(storage(), "session-a"), "/session pin 2 --exclusive");
		const unpinResult = await runSessionCommand(stubSession(storage(), "session-a"), "/session unpin");
		expect(unpinResult).toContain("Released the pinned account");
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-a")).toBe(false);

		const repin = await runSessionCommand(stubSession(storage(), "session-b"), "/session pin 2 --exclusive");
		expect(repin).toContain("Pinned b@example.com exclusively");
		expect(storage().hasExclusiveSessionPin(PROVIDER, "session-b")).toBe(true);
	});

	it("reports unpinned state for /session unpin without a pin", async () => {
		const result = await runSessionCommand(stubSession(storage(), "session-a"), "/session unpin");
		expect(result).toContain("No pinned account to release");
	});
});
