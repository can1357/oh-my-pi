import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	findSessionFiles,
	listAllSessions,
	listRecentProjects,
	listRecentSessions,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";

const SESSION_ID = "0198aaaa-0000-7000-8000-000000000001";
const SESSION_NAME = `2026-10-15T00-00-00-000Z_${SESSION_ID}.jsonl`;

const modeBitsUnavailable = process.platform === "win32" || process.getuid?.() === 0;

describe("cross-project session bucket isolation", () => {
	let sessionsRoot = "";
	let blockedBucket = "";
	let sessionFile = "";
	const restoreModes: string[] = [];

	beforeEach(async () => {
		sessionsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-session-buckets-"));
		blockedBucket = path.join(sessionsRoot, "z-unavailable");
		await fs.promises.mkdir(blockedBucket);
		sessionFile = path.join(sessionsRoot, "a-readable", SESSION_NAME);
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: SESSION_ID,
					timestamp: "2026-10-15T00:00:00.000Z",
					cwd: "/tmp/project",
					title: "Readable session",
				}),
				JSON.stringify({
					type: "message",
					id: "user-1",
					timestamp: "2026-10-15T00:00:00.000Z",
					message: { role: "user", content: "ping", timestamp: 0 },
				}),
			].join("\n") + "\n",
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of restoreModes.splice(0)) await fs.promises.chmod(dir, 0o700);
		if (sessionsRoot) await fs.promises.rm(sessionsRoot, { recursive: true, force: true });
	});

	it.skipIf(modeBitsUnavailable)("keeps an exact session match when an unrelated bucket is unreadable", async () => {
		expect(await findSessionFiles(SESSION_ID, sessionsRoot)).toEqual([sessionFile]);
		await fs.promises.chmod(blockedBucket, 0o000);
		restoreModes.push(blockedBucket);
		await expect(fs.promises.readdir(blockedBucket)).rejects.toMatchObject({ code: "EACCES" });

		expect(await findSessionFiles(SESSION_ID, sessionsRoot)).toEqual([sessionFile]);
		expect((await listAllSessions(undefined, sessionsRoot)).map(session => session.id)).toEqual([SESSION_ID]);
		expect((await listRecentSessions({ limit: 10, sessionsRoot })).map(session => session.id)).toEqual([SESSION_ID]);
		expect((await listRecentProjects(10, sessionsRoot)).map(project => project.latest.id)).toEqual([SESSION_ID]);
	});

	it.each(["EACCES", "EPERM", "ENOENT", "ENOTDIR"])("discards a bucket's partial matches on %s", async code => {
		await fs.promises.copyFile(sessionFile, path.join(blockedBucket, SESSION_NAME));
		const scan = Bun.Glob.prototype.scan;
		vi.spyOn(Bun.Glob.prototype, "scan").mockImplementation(async function* (this: Bun.Glob, options) {
			if (typeof options === "object" && options.cwd === blockedBucket) {
				yield SESSION_NAME;
				throw Object.assign(new Error("bucket unavailable"), { code });
			}
			yield* scan.call(this, options);
		});

		expect(await findSessionFiles(SESSION_ID, sessionsRoot)).toEqual([sessionFile]);
	});

	it("surfaces an unexpected bucket enumeration failure during exact-id lookup", async () => {
		const failure = Object.assign(new Error("bucket I/O failure"), { code: "EIO" });
		vi.spyOn(Bun.Glob.prototype, "scan").mockImplementationOnce(async function* () {
			yield SESSION_NAME;
			throw failure;
		});

		await expect(findSessionFiles(SESSION_ID, sessionsRoot)).rejects.toBe(failure);
	});

	it("surfaces an unexpected root enumeration failure during exact-id lookup", async () => {
		const failure = Object.assign(new Error("root I/O failure"), { code: "EIO" });
		vi.spyOn(fs.promises, "readdir").mockRejectedValueOnce(failure);

		await expect(findSessionFiles(SESSION_ID, sessionsRoot)).rejects.toBe(failure);
	});

	it.skipIf(modeBitsUnavailable)("surfaces an unreadable sessions root instead of claiming it is empty", async () => {
		await fs.promises.chmod(sessionsRoot, 0o000);
		restoreModes.push(sessionsRoot);
		await expect(findSessionFiles(SESSION_ID, sessionsRoot)).rejects.toMatchObject({ code: "EACCES" });
	});

	it("keeps missing or non-directory sessions roots empty", async () => {
		expect(await findSessionFiles(SESSION_ID, path.join(sessionsRoot, "missing"))).toEqual([]);
		expect(await findSessionFiles(SESSION_ID, sessionFile)).toEqual([]);
	});
});
