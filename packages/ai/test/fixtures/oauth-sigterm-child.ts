import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";

const db = process.argv[2];
const release = process.argv[3];
if (!db || !release) throw new Error("Expected database and response-release paths");
await AgentStorage.open(db);
const auth = new AuthStorage(await SqliteAuthCredentialStore.open(db));
await auth.credentials.set("anthropic", [{ type: "oauth", access: "old", refresh: "old-refresh", expires: 0 }]);
await auth.oauth.refreshStored("anthropic", {
	forceRefresh: true,
	credentialFromRow: credential => credential,
	refresh: async current => {
		// The provider has consumed the old token before its response reaches the client.
		process.stdout.write("rotated\n");
		while (!(await Bun.file(release).exists())) await Bun.sleep(10);
		return { ...current, access: "new", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
	},
});
