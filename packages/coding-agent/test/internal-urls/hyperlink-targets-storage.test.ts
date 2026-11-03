/**
 * A `history://<id>` link in chat resolves to the transcript's local file, so
 * a click opens it in the editor. Under `session.storage: sql` the transcript
 * is a row with no file behind it: the link must keep its `history://` target
 * rather than point the editor at a path that does not exist.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveMarkdownLinkHrefs } from "@oh-my-pi/pi-coding-agent/internal-urls/hyperlink-targets";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("history:// link targets storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		AgentRegistry.resetGlobalForTests();
	});

	for (const kind of ["file", "sql"] as const) {
		it(`${kind === "file" ? "links" : "does not link"} a history:// target ${kind} storage holds`, async () => {
			const previous = defaultSessionStorage();
			let storage: SessionStorage = new FileSessionStorage();
			if (kind === "sql") {
				const client = new SQL("sqlite::memory:");
				storage = await SqlSessionStorage.create({ client });
				cleanups.push(() => client.end());
			}
			setDefaultSessionStorage(storage);
			cleanups.push(() => setDefaultSessionStorage(previous));
			const dir = TempDir.createSync("@omp-history-link-storage-");
			cleanups.push(() => dir.removeSync());
			const sessionFile = dir.join("main", "Linked.jsonl");
			await storage.writeText(
				sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: "Linked", timestamp: "2026-11-02T00:00:00.000Z", cwd: "/tmp" })}\n`,
			);
			AgentRegistry.global().register({
				id: "Linked",
				displayName: "Linked",
				kind: "sub",
				session: null,
				sessionFile,
				status: "parked",
			});

			const targets = await resolveMarkdownLinkHrefs(["history://Linked"]);

			expect(targets.get("history://Linked")).toBe(
				kind === "file" ? fileUriForTerminal(sessionFile, undefined, TERMINAL.id) : undefined,
			);
		});
	}
});
