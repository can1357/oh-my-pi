import "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-session";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PROVIDER = "anthropic";
const sessionSpec = BUILTIN_SESSION_SLASH_COMMANDS.find(spec => spec.name === "session");

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

async function runSessionCommand(session: AgentSession, text: string): Promise<string> {
	if (!sessionSpec?.handle) throw new Error("no handler");
	const parsed = parseSlashCommand(text);
	if (!parsed) throw new Error("bad cmd");
	const lines: string[] = [];
	const runtime = {
		session,
		output: (o: string) => lines.push(o),
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	} as SlashCommandRuntime;
	await sessionSpec.handle(parsed, runtime);
	return lines.join("\n");
}

function stubSession(authStorage: AuthStorage, sessionId: string): AgentSession {
	return {
		isStreaming: false,
		sessionId,
		modelRegistry: { authStorage },
		listCurrentProviderOAuthAccounts: () =>
			Promise.resolve({ provider: PROVIDER, accounts: authStorage.listOAuthAccounts(PROVIDER, sessionId) }),
		pinCurrentProviderOAuthAccount: (credentialId: number, options?: { exclusive?: boolean }) =>
			authStorage.pinSessionOAuthAccount(PROVIDER, sessionId, credentialId, options),
		unpinCurrentProviderOAuthAccount: () => authStorage.unpinSessionOAuthAccount(PROVIDER, sessionId),
	} as unknown as AgentSession;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "exclusive-pin-demo-"));
const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
const authStorage = new AuthStorage(store);
await authStorage.set(PROVIDER, [oauthCredential("alpha"), oauthCredential("beta")]);

const s1 = stubSession(authStorage, "session-1");
const s2 = stubSession(authStorage, "session-2");

const out = {
	session1_pin: await runSessionCommand(s1, "/session pin 2 --exclusive"),
	session1_list: await runSessionCommand(s1, "/session pin"),
	session2_list: await runSessionCommand(s2, "/session pin"),
	session2_try: await runSessionCommand(s2, "/session pin 2 --exclusive"),
};
console.log(JSON.stringify(out));
store.close();
