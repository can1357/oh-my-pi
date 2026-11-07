/**
 * The blob sweep against sessions that are reachable only through symbolic
 * links: the transcript is a blob-store entry, the store is reached under
 * another name, the path runs through a chain of entries, a relative link
 * leads out of a linked session directory, or the tree is rearranged while
 * the sweep has the transcript open. Each row names a session that a sweep
 * once made unreachable, with `errors: []` and exit 0.
 *
 * The rows are #17398's, run here against this branch's walk. Nine hold as
 * that lane wrote them; P1 does not, and says why in its own words.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { type GcResult, runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getBlobsDir, getCustomSessionFilesDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let root: string;
let settingsState: SettingsTestState | undefined;
let stdoutSpy: { mockRestore(): void } | undefined;
let stderrSpy: { mockRestore(): void } | undefined;
const originalExitCode = process.exitCode;

function hashFor(label: string): string {
	return new Bun.SHA256().update(label).digest("hex");
}

async function writeSession(
	agentDir: string,
	project: string,
	id: string,
	status: "complete" | "pending" | "interrupted",
	options: { blobRef?: string; ageDays?: number; filename?: string } = {},
): Promise<string> {
	const sessionDir = path.join(getSessionsDir(agentDir), project);
	await fs.mkdir(sessionDir, { recursive: true });
	const file = path.join(sessionDir, `${options.filename ?? id}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" }),
	];
	if (options.blobRef) {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: options.blobRef } }));
	}
	if (status === "complete") {
		lines.push(JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }));
	} else {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: "waiting" } }));
	}
	await Bun.write(file, `${lines.join("\n")}\n`);
	if (options.ageDays !== undefined) {
		const ts = new Date(Date.now() - options.ageDays * 86_400_000);
		await fs.utimes(file, ts, ts);
	}
	return file;
}

async function writeBlob(agentDir: string, hash: string, content: string): Promise<string> {
	const file = path.join(getBlobsDir(agentDir), hash);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	return file;
}

async function agePath(file: string, ageDays = 1): Promise<void> {
	const ts = new Date(Date.now() - ageDays * 86_400_000);
	await fs.utimes(file, ts, ts);
}

beforeEach(async () => {
	settingsState = beginSettingsTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-port-"));
	process.exitCode = 0;
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	stderrSpy?.mockRestore();
	stderrSpy = undefined;
	process.exitCode = originalExitCode;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	AgentStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

describe("blob sweep: a session reachable only through links", () => {
	test("P1 reclaims an unreferenced blob while a session is reachable through a symlink", async () => {
		const referencedHash = hashFor("referenced");
		const orphanHash = hashFor("orphan");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		const orphan = await writeBlob(root, orphanHash, "orphan");
		await agePath(referenced);
		await agePath(orphan);
		const elsewhere = path.join(root, "elsewhere");
		await fs.mkdir(elsewhere, { recursive: true });
		const offloaded = await writeSession(root, "project", "linked", "complete", {
			blobRef: `blob:sha256:${referencedHash}`,
		});
		const moved = path.join(elsewhere, path.basename(offloaded));
		await fs.rename(offloaded, moved);
		await fs.symlink(moved, offloaded);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		// #17398 expected `deleted` 0 here: its design refused the whole sweep
		// whenever any session was reachable through a link, so an unreferenced
		// blob beside it was never reclaimed either. This branch chose the
		// opposite in round 56 — it reads the transcript through the link and
		// goes on reclaiming — and gc-cli.test.ts' "round56 blob sweep reads a
		// live transcript link by content" and "round56 an offline linked
		// transcript cannot lose its persisted image blob" both assert
		// `errors: []` for this very shape: a session file in the tree that is
		// a link to a transcript outside it. A rule that refuses here refuses
		// there too, so the two expectations cannot both hold. What must never
		// happen is losing a blob a reachable session references, and that is
		// what this row pins.
		expect(result.blobs?.deleted).toBe(1);
		expect(result.blobs?.errors).toEqual([]);
		expect(await Bun.file(referenced).exists()).toBe(true);
		expect(await Bun.file(orphan).exists()).toBe(false);
	});

	test("P2 reads a compressed transcript by its bytes, whatever its name is", async () => {
		const innerHash = hashFor("compressed-inner");
		const inner = await writeBlob(root, innerHash, "inner");
		const orphan = await writeBlob(root, hashFor("compressed-orphan"), "orphan");
		await agePath(inner);
		await agePath(orphan);
		const externalDir = path.join(root, "external-sessions");
		await fs.mkdir(externalDir, { recursive: true });
		const transcript = path.join(externalDir, hashFor("compressed-transcript"));
		await Bun.write(
			transcript,
			gzipSync(`${JSON.stringify({ type: "message", ref: `blob:sha256:${innerHash}` })}\n`),
		);
		const registryDir = getCustomSessionFilesDir(root);
		await fs.mkdir(registryDir, { recursive: true });
		await Bun.write(path.join(registryDir, "session-1"), transcript);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(1);
		expect(await Bun.file(inner).exists()).toBe(true);
		expect(await Bun.file(orphan).exists()).toBe(false);
	});

	test("P3 keeps a blob that is itself a transcript linked into the sessions tree", async () => {
		const innerHash = hashFor("inner");
		const inner = await writeBlob(root, innerHash, "inner");
		await agePath(inner);
		const session = await writeSession(root, "project", "linked-target", "complete", {
			blobRef: `blob:sha256:${innerHash}`,
		});
		const transcript = await Bun.file(session).bytes();
		const transcriptHash = hashFor("transcript-as-blob");
		const asBlob = path.join(getBlobsDir(root), transcriptHash);
		await Bun.write(asBlob, transcript);
		await fs.rm(session);
		await fs.symlink(asBlob, session);
		await agePath(asBlob);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(asBlob).exists()).toBe(true);
		expect(await Bun.file(inner).exists()).toBe(true);
		expect((await fs.lstat(session)).isSymbolicLink()).toBe(true);
	});

	test("P4 keeps a blob referenced by a linked recoverable backup", async () => {
		const referencedHash = hashFor("referenced");
		const referenced = await writeBlob(root, referencedHash, "referenced");
		await agePath(referenced);
		const elsewhere = path.join(root, "elsewhere");
		await fs.mkdir(elsewhere, { recursive: true });
		const backup = path.join(elsewhere, "linked.jsonl.1.bak");
		await Bun.write(backup, `${JSON.stringify({ type: "message", ref: `blob:sha256:${referencedHash}` })}\n`);
		const sessions = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessions, { recursive: true });
		await fs.symlink(backup, path.join(sessions, "linked.jsonl.1.bak"));
		await fs.symlink(elsewhere, path.join(sessions, "linked-dir"));

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(referenced).exists()).toBe(true);
	});

	test("P5 keeps a transcript blob reached through a symlinked blob directory", async () => {
		const innerHash = hashFor("inner-alias");
		const inner = await writeBlob(root, innerHash, "inner");
		const session = await writeSession(root, "project", "aliased", "complete", {
			blobRef: `blob:sha256:${innerHash}`,
		});
		const transcript = await Bun.file(session).bytes();
		const elsewhere = path.join(root, "elsewhere-blobs");
		await fs.rename(getBlobsDir(root), elsewhere);
		await fs.symlink(elsewhere, getBlobsDir(root));
		const transcriptHash = hashFor("transcript-aliased");
		const asBlob = path.join(elsewhere, transcriptHash);
		await Bun.write(asBlob, transcript);
		await fs.rm(session);
		await fs.symlink(asBlob, session);
		await agePath(asBlob);
		await agePath(path.join(elsewhere, innerHash));

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(asBlob).exists()).toBe(true);
		expect(await Bun.file(inner.replace(getBlobsDir(root), elsewhere)).exists()).toBe(true);
		expect((await fs.lstat(session)).isSymbolicLink()).toBe(true);
	});

	test("P6 keeps every blob on the path a session is reachable through", async () => {
		const innerHash = hashFor("inner-chain");
		const transcriptHash = hashFor("transcript-chain");
		const firstHop = hashFor("first-hop");
		const secondHop = hashFor("second-hop");
		const blobs = getBlobsDir(root);
		const session = await writeSession(root, "project", "chained", "complete", {
			blobRef: `blob:sha256:${innerHash}`,
		});
		const inner = await writeBlob(root, innerHash, "inner");
		const transcript = path.join(blobs, transcriptHash);
		await Bun.write(transcript, await Bun.file(session).bytes());
		await fs.symlink(transcript, path.join(blobs, firstHop));
		await fs.symlink(path.join(blobs, firstHop), path.join(blobs, secondHop));
		await fs.rm(session);
		await fs.symlink(path.join(blobs, secondHop), session);
		for (const file of [transcript, path.join(blobs, firstHop), path.join(blobs, secondHop), inner]) {
			await agePath(file);
		}

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(session).text()).toContain(innerHash);
		expect(await Bun.file(inner).exists()).toBe(true);
	});

	test("P7 keeps a blob a relative link reaches through a linked directory", async () => {
		const innerHash = hashFor("inner-relative");
		const transcriptHash = hashFor("transcript-relative");
		const blobs = getBlobsDir(root);
		const inner = await writeBlob(root, innerHash, "inner");
		const session = await writeSession(root, "project", "relative", "complete", {
			blobRef: `blob:sha256:${innerHash}`,
		});
		const transcript = path.join(blobs, transcriptHash);
		await Bun.write(transcript, await Bun.file(session).bytes());
		await fs.rm(session);
		const offloaded = path.join(root, "offloaded");
		await fs.mkdir(offloaded, { recursive: true });
		await fs.symlink(path.join("..", "blobs", transcriptHash), path.join(offloaded, "relative.jsonl"));
		await fs.rm(path.dirname(session), { recursive: true });
		await fs.symlink(path.join("..", "offloaded"), path.dirname(session));
		for (const file of [transcript, inner]) await agePath(file);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(transcript).exists()).toBe(true);
		expect(await Bun.file(inner).exists()).toBe(true);
	});

	test("P8 deletes nothing when a session's path cannot be followed to the end", async () => {
		const orphan = await writeBlob(root, hashFor("orphan"), "orphan");
		await agePath(orphan);
		const blobs = getBlobsDir(root);
		let previous = path.join(blobs, hashFor("deep-end"));
		await Bun.write(previous, "deep");
		for (let hop = 0; hop < 34; hop++) {
			const link = path.join(blobs, hashFor(`deep-${hop}`));
			await fs.symlink(previous, link);
			previous = link;
		}
		const sessions = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessions, { recursive: true });
		await fs.symlink(previous, path.join(sessions, "deep.jsonl"));

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(orphan).exists()).toBe(true);
	});

	test("P9 keeps a blob reached through a blob-named link used as a directory", async () => {
		const blobs = getBlobsDir(root);
		const innerHash = hashFor("inner-prefix");
		const prefixHash = hashFor("prefix-link");
		const inner = await writeBlob(root, innerHash, "inner");
		const elsewhere = path.join(root, "offloaded-sessions");
		await fs.mkdir(elsewhere, { recursive: true });
		await Bun.write(
			path.join(elsewhere, "prefixed.jsonl"),
			`${JSON.stringify({ type: "message", ref: `blob:sha256:${innerHash}` })}\n`,
		);
		await fs.symlink(elsewhere, path.join(blobs, prefixHash));
		const sessions = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessions, { recursive: true });
		await fs.symlink(path.join(blobs, prefixHash, "prefixed.jsonl"), path.join(sessions, "prefixed.jsonl"));
		const aged = new Date(Date.now() - 86_400_000);
		await fs.lutimes(path.join(blobs, prefixHash), aged, aged);
		await agePath(inner);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.deleted).toBe(0);
		expect((await fs.lstat(path.join(blobs, prefixHash))).isSymbolicLink()).toBe(true);
		expect(await Bun.file(inner).exists()).toBe(true);
	});

	test("P10 reads the session it opened, not whatever the name means afterwards", async () => {
		const outerHash = hashFor("outer-kept");
		const decoyHash = hashFor("decoy-referenced");
		const outer = await writeBlob(root, outerHash, "outer");
		const decoy = await writeBlob(root, decoyHash, "decoy");
		await agePath(outer);
		await agePath(decoy);
		const original = path.join(root, "external", "original");
		await fs.mkdir(path.dirname(original), { recursive: true });
		await Bun.write(original, `${JSON.stringify({ type: "message", ref: `blob:sha256:${outerHash}` })}\n`);
		const offloaded = path.join(root, "offloaded");
		await fs.mkdir(offloaded, { recursive: true });
		await fs.symlink(path.join("..", "external", "original"), path.join(offloaded, "session.jsonl"));
		const sessions = path.join(getSessionsDir(root), "project");
		await fs.mkdir(sessions, { recursive: true });
		await fs.symlink(path.join(offloaded, "session.jsonl"), path.join(sessions, "session.jsonl"));
		const replacement = path.join(root, "replacement");
		await fs.mkdir(replacement, { recursive: true });
		await Bun.write(
			path.join(replacement, "session.jsonl"),
			`${JSON.stringify({ type: "message", ref: `blob:sha256:${decoyHash}` })}\n`,
		);
		const realOpen = fs.open;
		let swapped = false;
		const open = spyOn(fs, "open").mockImplementation((async (target: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (...args: unknown[]) => Promise<fs.FileHandle>)(target, ...rest);
			if (!swapped && String(target).endsWith("session.jsonl")) {
				swapped = true;
				await fs.rename(offloaded, path.join(root, "offloaded-gone"));
				await fs.rename(replacement, offloaded);
			}
			return handle;
		}) as typeof fs.open);
		let result: GcResult;
		try {
			result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });
		} finally {
			open.mockRestore();
		}

		expect(await Bun.file(outer).exists()).toBe(true);
		expect(result.blobs?.errors.length ?? 0).toBeGreaterThan(0);
	});

	test("keeps a blob only a rotated backup beside an offloaded session references", async () => {
		const liveHash = hashFor("live-reference");
		const backupHash = hashFor("backup-only-reference");
		const live = await writeBlob(root, liveHash, "live");
		const backup = await writeBlob(root, backupHash, "backup");
		await agePath(live);
		await agePath(backup);
		const elsewhere = path.join(root, "offloaded");
		await fs.mkdir(elsewhere, { recursive: true });
		const session = await writeSession(root, "project", "rotated", "complete", {
			blobRef: `blob:sha256:${liveHash}`,
		});
		const moved = path.join(elsewhere, path.basename(session));
		await fs.rename(session, moved);
		await fs.symlink(moved, session);
		// The rotation a compaction leaves: the current transcript no longer
		// names this blob, and only the backup beside it does.
		await Bun.write(`${moved}.1.bak`, `${JSON.stringify({ type: "message", ref: `blob:sha256:${backupHash}` })}\n`);

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(result.blobs?.errors).toEqual([]);
		expect(result.blobs?.deleted).toBe(0);
		expect(await Bun.file(live).exists()).toBe(true);
		expect(await Bun.file(backup).exists()).toBe(true);
	});
});
