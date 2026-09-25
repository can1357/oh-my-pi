import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * getLastAgentName() (persona restore) and the prompt-cache-key fork feature both
 * depend on `persona_change`/history entries surviving an arbitrary number of
 * fork generations, across process boundaries (fork -> resume in a fresh
 * process -> fork again -> resume again). Nothing re-records the persona on a
 * "restore" mode load (see AgentSession#applyAgentPersona), so this locks in
 * that the *original* persona_change entry keeps propagating forward through
 * every fork's copied history instead of getting silently dropped.
 */
describe("persona history through chained forks", () => {
	it("survives fork -> fresh-process-resume -> fork -> fresh-process-resume", async () => {
		using tempDir = TempDir.createSync("@omp-persona-fork-chain-");
		const cwd = tempDir.path();
		const sessionDir = tempDir.join("sessions");

		// 1. Fresh session (session1): startup applies first_persona (mode "cycle" -> record=true)
		const s1 = SessionManager.create(cwd, sessionDir);
		expect(s1.getBranch().length).toBe(0);
		s1.appendPersonaChange("first_persona");
		expect(s1.getLastAgentName()).toBe("first_persona");

		// 2. User Tabs to second_persona (mode "cycle" -> record=true)
		s1.appendPersonaChange("second_persona");
		expect(s1.getLastAgentName()).toBe("second_persona");
		expect(s1.getBranch().length).toBe(2);

		// 3. Interactive fork (in-process instance method) -> session2
		const forkResult1 = await s1.fork();
		expect(forkResult1).toBeDefined();
		// In-process, entries carry over immediately (same array, new header/file).
		expect(s1.getLastAgentName()).toBe("second_persona");
		expect(s1.getBranch().length).toBe(2);
		await s1.flush();

		// 4. A FRESH PROCESS opens/resumes session2 from disk (mirrors createAgentSession startup)
		const session2File = forkResult1!.newSessionFile;
		const s2fresh = await SessionManager.open(session2File, sessionDir);
		const existingBranch2 = s2fresh.getBranch();
		expect(existingBranch2.length).toBeGreaterThan(0); // hasExistingSession === true
		expect(s2fresh.getLastAgentName()).toBe("second_persona"); // -> mode "restore" resolves correctly

		// 5. That fresh process forks AGAIN (session2 -> session3) without writing any new
		//    persona_change (mode "restore" never records).
		const session2Id = s2fresh.getHeader()?.id;
		const forkResult2 = await s2fresh.fork();
		expect(forkResult2).toBeDefined();
		// 6. A THIRD fresh process opens/resumes session3 (grandchild fork) from disk.
		const session3File = forkResult2!.newSessionFile;
		const s3fresh = await SessionManager.open(session3File, sessionDir);
		const existingBranch3 = s3fresh.getBranch();
		expect(existingBranch3.length).toBeGreaterThan(0);
		expect(s3fresh.getLastAgentName()).toBe("second_persona");
		expect(s3fresh.getHeader()?.parentSession).toBe(session2Id);
	});
});
