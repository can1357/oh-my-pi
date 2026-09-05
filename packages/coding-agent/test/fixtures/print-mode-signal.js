import { runPrintMode } from "../../src/modes/print-mode.ts";

const marker = process.argv[2];
if (!marker) throw new Error("Missing disposal marker path");

const session = {
	extensionRunner: undefined,
	subscribe() {},
	settings: { get: () => false },
	sessionManager: {
		buildSessionContext: () => ({ messages: [] }),
		getEntries: () => [],
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
