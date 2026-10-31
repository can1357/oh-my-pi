import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as runtimeIdentity from "@oh-my-pi/pi-coding-agent/session/runtime-identity";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const BUILD_A: runtimeIdentity.RuntimeIdentity = { version: "1.0.0", commit: "a".repeat(40), branch: "will/a" };
const BUILD_B: runtimeIdentity.RuntimeIdentity = { ...BUILD_A, diff: "beef" };

function runAs(build: runtimeIdentity.RuntimeIdentity): void {
	spyOn(runtimeIdentity, "currentRuntimeIdentity").mockReturnValue(build);
}

function writers(entries: readonly SessionEntry[]): Array<string | undefined> {
	return entries.map(entry => (entry.runtime ? (entry.runtime.diff ?? entry.runtime.branch) : undefined));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("session runtime identity", () => {
	it("credits each entry to the build that wrote it across a resume by a different build", async () => {
		using tempDir = TempDir.createSync("@pi-runtime-identity-");
		runAs(BUILD_A);
		const original = SessionManager.create(tempDir.path(), tempDir.path());
		original.appendMessage({ role: "user", content: "first", timestamp: 1 });
		await original.ensureOnDisk();
		const file = original.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");

		runAs(BUILD_B);
		const resumed = await SessionManager.open(file, tempDir.path());
		resumed.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await resumed.flush();

		const reloaded = await SessionManager.open(file, tempDir.path());
		expect(writers(reloaded.getEntries())).toEqual(["will/a", "beef"]);
		expect(runtimeIdentity.runtimeIdentityHistory(reloaded.getEntries())).toEqual([BUILD_A, BUILD_B]);
	});

	it("keeps the original writers on entries a branched session copies", async () => {
		using tempDir = TempDir.createSync("@pi-runtime-identity-branch-");
		runAs(BUILD_A);
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const keptLeafId = session.appendMessage({ role: "user", content: "kept", timestamp: 2 });

		runAs(BUILD_B);
		session.createBranchedSession(keptLeafId);
		session.appendMessage({ role: "user", content: "after branching", timestamp: 3 });

		expect(writers(session.getEntries())).toEqual(["will/a", "will/a", "beef"]);
	});

	it("keeps the host's writer on entries a collab guest ingests", () => {
		runAs(BUILD_A);
		const host = SessionManager.inMemory();
		host.appendMessage({ role: "user", content: "from host", timestamp: 1 });
		const [hostEntry] = host.getEntries();

		runAs(BUILD_B);
		const guest = SessionManager.inMemory();
		guest.ingestReplicatedEntry(structuredClone(hostEntry));
		guest.appendMessage({ role: "user", content: "from guest", timestamp: 2 });

		expect(writers(guest.getEntries())).toEqual(["will/a", "beef"]);
	});

	it("lists a run that wrote before its diff was read under the diff it read, once", () => {
		const pending: runtimeIdentity.RuntimeIdentity = { ...BUILD_A, diff: "unknown" };
		const session = SessionManager.inMemory();
		for (const build of [pending, BUILD_B, pending, BUILD_A]) {
			runAs(build);
			session.appendMessage({ role: "user", content: "turn", timestamp: 1 });
		}
		// The second `unknown` run cannot be told apart from BUILD_B; BUILD_A (clean) is a new build.
		expect(runtimeIdentity.runtimeIdentityHistory(session.getEntries())).toEqual([BUILD_B, BUILD_A]);
	});

	it("treats a malformed stamp read from disk as unstamped", () => {
		runAs(BUILD_A);
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "turn", timestamp: 1 });
		const [entry] = session.getEntries();
		const malformed = { ...entry, runtime: { version: "1.0.0", commit: 42 } } as unknown as SessionEntry;
		expect(runtimeIdentity.runtimeIdentityHistory([malformed, entry])).toEqual([null, BUILD_A]);
	});
});
