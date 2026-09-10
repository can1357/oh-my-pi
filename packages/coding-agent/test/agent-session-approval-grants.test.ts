import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	addSimilarApproval,
	approvalIdentity,
	approveToolForSession,
	clearSessionApprovals,
	getSimilarApprovals,
	isToolApprovedForSession,
} from "@oh-my-pi/pi-coding-agent/tools/session-approvals";
import { TempDir } from "@oh-my-pi/pi-utils";

// The approval-grant store is module-global, so every session id this file
// touches is released again — a leaked entry would follow the whole run.
const grantedSessionIds: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	sharedDir = TempDir.createSync("@pi-agent-session-approval-grants-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
});

afterAll(() => {
	authStorage.close();
	sharedDir.removeSync();
});

afterEach(async () => {
	for (const id of grantedSessionIds) clearSessionApprovals(id);
	grantedSessionIds.length = 0;
	while (cleanup.length > 0) {
		const run = cleanup.pop();
		if (run) await run();
	}
});

interface GrantHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: TempDir;
}

async function createHarness(): Promise<GrantHarness> {
	const tempDir = TempDir.createSync("@pi-agent-session-approval-grants-");
	const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	const agent = new Agent({ initialState: { systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({ agent, sessionManager, settings: Settings.isolated(), modelRegistry });
	cleanup.push(async () => {
		await session.dispose();
		tempDir.removeSync();
	});
	return { session, sessionManager, tempDir };
}

/** Grant both option kinds for the live session so either leak would show. */
function grantForCurrentSession(sessionManager: SessionManager): string {
	const sessionId = sessionManager.getSessionId();
	grantedSessionIds.push(sessionId);
	approveToolForSession(sessionId, "bash");
	addSimilarApproval(sessionId, "write", "Path: src/a.ts", approvalIdentity({ path: "src/a.ts" }));
	expect(isToolApprovedForSession(sessionId, "bash")).toBe(true);
	return sessionId;
}

function expectNoGrants(sessionId: string): void {
	expect(isToolApprovedForSession(sessionId, "bash")).toBe(false);
	expect(getSimilarApprovals(sessionId, "write")).toEqual([]);
}

/** A minimal persisted session, so the same session id can be re-opened later. */
async function writeSessionFile(dir: string): Promise<string> {
	const id = `approval-grant-target-${Bun.nanoseconds()}`;
	const sessionPath = path.join(dir, `${id}.jsonl`);
	await Bun.write(
		sessionPath,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: new Date().toISOString(),
			cwd: dir,
		})}\n`,
	);
	return sessionPath;
}

it.each(["new", "switch"] as const)(
	"a %s session boundary releases the grants of the session it leaves",
	async transition => {
		const { session, sessionManager, tempDir } = await createHarness();
		const previousSessionId = grantForCurrentSession(sessionManager);

		if (transition === "new") {
			expect(await session.newSession()).toBe(true);
		} else {
			expect(await session.switchSession(await writeSessionFile(tempDir.path()))).toBe(true);
		}

		const currentSessionId = sessionManager.getSessionId();
		expect(currentSessionId).not.toBe(previousSessionId);
		// The abandoned id must not keep an entry alive, and the session we landed
		// in must start ungranted.
		expectNoGrants(previousSessionId);
		expectNoGrants(currentSessionId);
	},
);

it("resetting the conversation drops the grants of the session it keeps", async () => {
	const { session, sessionManager } = await createHarness();
	const sessionId = grantForCurrentSession(sessionManager);

	expect(await session.resetSessionContext()).toBeDefined();

	expect(sessionManager.getSessionId()).toBe(sessionId);
	expectNoGrants(sessionId);
});

it("rotating only the provider session id keeps the grants of the live session", async () => {
	const { session, sessionManager } = await createHarness();
	const sessionId = grantForCurrentSession(sessionManager);

	expect(session.freshSession()).toBeDefined();

	expect(sessionManager.getSessionId()).toBe(sessionId);
	expect(isToolApprovedForSession(sessionId, "bash")).toBe(true);
	expect(getSimilarApprovals(sessionId, "write").map(entry => entry.subject)).toEqual(["Path: src/a.ts"]);
});

it("disposing a session releases its grants and a re-opened session id starts ungranted", async () => {
	const { session, sessionManager, tempDir } = await createHarness();
	// Grant inside a persisted session, so the granted id survives on disk and can
	// be re-opened after dispose.
	const sessionPath = await writeSessionFile(tempDir.path());
	expect(await session.switchSession(sessionPath)).toBe(true);
	const sessionId = grantForCurrentSession(sessionManager);

	await session.dispose();

	expectNoGrants(sessionId);

	// Revive that id the way a lifecycle revival / `history://` re-entry does: a
	// fresh manager over the same file. Reviving through AgentSession.switchSession
	// would prove nothing — that path clears the grants of the session it lands in
	// by itself, whether or not dispose released them.
	const revived = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	await revived.setSessionFile(sessionPath);
	expect(revived.getSessionId()).toBe(sessionId);
	expectNoGrants(revived.getSessionId());
	await revived.close();
});
