import * as fs from "node:fs";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { postmortem } from "@oh-my-pi/pi-utils";

// Usage: <db> <exchange-marker> <during-pass|after-pass>
const [db, marker, mode] = process.argv.slice(2);
if (!db || !marker || !mode) throw new Error("Expected database, marker path and mode");
const auth = new AuthStorage(await SqliteAuthCredentialStore.open(db));
await auth.credentials.reload();

const startRefresh = (): void => {
	fs.writeFileSync(`${marker}.started`, "started");
	auth.oauth
		.refreshStored("anthropic", {
			forceRefresh: true,
			credentialFromRow: credential => credential,
			refresh: async current => {
				// The provider rotates the token on receipt; its answer is slow to arrive.
				await Bun.write(marker, "exchanged");
				await Bun.sleep(6_000);
				return { ...current, access: "new", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
			},
		})
		.catch(() => {});
};

if (mode === "during-pass") {
	// Another owner's cleanup keeps the exit pass open, and a refresh starts while it runs.
	postmortem.register("slow-owner", async () => {
		startRefresh();
		await Bun.sleep(1_000);
	});
} else {
	// The exit pass has finished and quit is about to exit when a refresh starts (work
	// that outlived the pass, say). Hold the real exit for a second, less than the exchange.
	const realExit = process.exit.bind(process);
	process.exit = ((code?: number) => {
		startRefresh();
		setTimeout(() => realExit(code), 1_000);
	}) as typeof process.exit;
}
await postmortem.quit(0);
