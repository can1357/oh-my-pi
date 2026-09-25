import { Settings } from "../../src/config/settings.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";

const marker = process.argv[2];
if (!marker) throw new Error("Missing disposal marker path");

const session = {
	extensionRunner: undefined,
	subscribe() {},
	settings: Settings.isolated(),
	sessionManager: {
		buildSessionContext: () => ({ messages: [] }),
		getEntries: () => [],
		onPersistenceError: () => () => {},
	},
	setTextOutputCommitted() {},
	async prompt() {
		process.kill(process.pid, "SIGTERM");
		await Promise.withResolvers().promise;
	},
	async dispose(options = {}) {
		await Bun.write(marker, options.reason ?? "dispose");
	},
};

await runPrintMode(session, { mode: "text", initialMessage: "wait for signal" });
