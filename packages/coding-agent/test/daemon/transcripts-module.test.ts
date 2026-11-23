import { afterEach, beforeEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, getTranscriptIndexDbPath, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type { ModuleClient, ModuleContext } from "../../src/daemon/module";
import { TRANSCRIPTS_SYNC_METHOD, transcriptsModule } from "../../src/daemon/modules/transcripts";

const CLIENT: ModuleClient = { connectionId: "transcripts-test", pid: process.pid, build: "test" };
// The transcripts module uses no core services.
const CONTEXT = {} as ModuleContext;

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-transcripts-module-"));
	// The daemon's own agent dir: a call must never index it.
	setAgentDir(path.join(root, "daemon-agent"));
});

afterEach(async () => {
	await transcriptsModule.dispose?.();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(path.join(getConfigRootDir(), "agent"));
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(root);
});

function call(method: string, params: unknown): Promise<unknown> {
	if (!transcriptsModule.call) throw new Error("transcripts module serves no calls");
	return transcriptsModule.call(CONTEXT, method, params, CLIENT, undefined);
}

it("indexes the store and sessions the caller names, not the daemon's own", async () => {
	const sessionsRoot = path.join(root, "client-agent", "sessions");
	const bucket = path.join(sessionsRoot, "--proj--");
	fs.mkdirSync(bucket, { recursive: true });
	fs.writeFileSync(
		path.join(bucket, "2024-01-01T00-00-00-000Z_s1.jsonl"),
		`${JSON.stringify({ type: "session", id: "s1", cwd: "/proj" })}\n${JSON.stringify({
			type: "message",
			message: { role: "user", content: "index me" },
		})}\n`,
	);
	const dbPath = path.join(root, "client-agent", "transcripts.db");

	expect(await call(TRANSCRIPTS_SYNC_METHOD, { dbPath, sessionsRoot })).toEqual({
		outcome: "synced",
		files: 1,
		messages: 1,
	});
	const db = new Database(dbPath, { readonly: true });
	try {
		expect(db.query("SELECT text FROM messages").all()).toEqual([{ text: "index me" }]);
	} finally {
		db.close();
	}
	expect(fs.existsSync(getTranscriptIndexDbPath())).toBe(false);
});

it("rejects unknown methods and malformed targets", async () => {
	await expect(call("rebuild", {})).rejects.toThrow("unknown transcripts method");
	await expect(call(TRANSCRIPTS_SYNC_METHOD, { dbPath: "/tmp/x.db" })).rejects.toThrow(
		"invalid transcripts sync target",
	);
});
