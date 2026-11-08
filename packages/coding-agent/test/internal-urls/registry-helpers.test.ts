/**
 * Contract: `hasResolvableTranscript` mirrors the availability half of
 * `HistoryProtocolHandler.resolve` — it must return true exactly when a
 * `history://<id>` link would serve a transcript (live session, verified
 * retained session file, or on-disk `.jsonl` under a known artifacts dir),
 * and false otherwise, without ever throwing. Follow-up hints in
 * `task/index.ts` gate their `history://` links on it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupTemporaryArtifactsDir,
	hasResolvableTranscript,
	registerArtifactsDir,
	registerTemporaryArtifactsDir,
	resetRegisteredArtifactDirsForTests,
	sweepTemporaryArtifactsDirs,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { persistNestedPatches } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function fakeLiveSession(): AgentSession {
	return { messages: [] } as unknown as AgentSession;
}

describe("hasResolvableTranscript", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("returns false for an unknown agent with nothing on disk", async () => {
		expect(await hasResolvableTranscript("Ghost")).toBe(false);
	});

	it("returns true for a live session, case-insensitively", async () => {
		AgentRegistry.global().register({
			id: "Live",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession(),
			status: "idle",
		});
		expect(await hasResolvableTranscript("Live")).toBe(true);
		expect(await hasResolvableTranscript("live")).toBe(true);
	});

	it("returns false for an aborted ref with no retained session file", async () => {
		AgentRegistry.global().register({
			id: "Aborted",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "aborted",
		});
		expect(await hasResolvableTranscript("Aborted")).toBe(false);
	});

	it("returns true for a running ref that has no session or session file yet", async () => {
		AgentRegistry.global().register({
			id: "Fresh",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "running",
		});
		expect(await hasResolvableTranscript("Fresh")).toBe(true);
	});

	it("returns false when the retained session file no longer exists on disk", async () => {
		AgentRegistry.global().register({
			id: "Stale",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/nonexistent/definitely/gone.jsonl",
			status: "aborted",
		});
		expect(await hasResolvableTranscript("Stale")).toBe(false);
	});

	it("returns true for a parked ref whose session file exists", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-helpers-"));
		try {
			const sessionFile = path.join(dir, "parked.jsonl");
			await Bun.write(sessionFile, "{}\n");
			AgentRegistry.global().register({
				id: "Parked",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile,
				status: "parked",
			});
			expect(await hasResolvableTranscript("Parked")).toBe(true);
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("falls back to the artifacts-dir disk scan for unregistered agents", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-helpers-"));
		try {
			await Bun.write(path.join(dir, "DiskOnly.jsonl"), "{}\n");
			const cleanup = registerArtifactsDir(dir);
			try {
				expect(await hasResolvableTranscript("DiskOnly")).toBe(true);
				expect(await hasResolvableTranscript("diskonly")).toBe(true);
			} finally {
				cleanup();
			}
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("excludes advisor refs, matching history:// visibility", async () => {
		AgentRegistry.global().register({
			id: "__advisor1",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession(),
			status: "running",
		});
		expect(await hasResolvableTranscript("__advisor1")).toBe(false);
	});

	it("sweeps only disposable leases, not caller-named directories or temp siblings", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "registry-sweep-"));
		try {
			const userDir = path.join(root, "caller-named");
			const leaseDir = path.join(root, "lease");
			const sibling = path.join(root, "not-ours.txt");
			await Bun.write(path.join(userDir, "Session.jsonl"), "user data\n");
			await Bun.write(path.join(leaseDir, "Worker.md"), "output\n");
			await Bun.write(sibling, "keep me\n");
			registerArtifactsDir(userDir);
			registerTemporaryArtifactsDir(leaseDir);
			sweepTemporaryArtifactsDirs();
			expect(await Bun.file(path.join(userDir, "Session.jsonl")).text()).toBe("user data\n");
			expect(await Bun.file(sibling).text()).toBe("keep me\n");
			expect(await Bun.file(path.join(leaseDir, "Worker.md")).exists()).toBe(false);
		} finally {
			await removeWithRetries(root);
		}
	});

	it("keeps every registered descendant, without confusing a sibling path for an owner", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "registry-shared-lease-"));
		try {
			const dir = path.join(root, "lease");
			const registry = AgentRegistry.global();
			for (const [id, file] of [
				["Parent", path.join(dir, "Parent.jsonl")],
				["Child", path.join(dir, "Parent/Child.jsonl")],
				["Sibling", path.join(root, "lease-other/Sibling.jsonl")],
			]) {
				await Bun.write(file!, `${id}\n`);
				registry.register({
					id: id!,
					displayName: id!,
					kind: "sub",
					session: null,
					sessionFile: file,
					status: "parked",
				});
			}
			registerTemporaryArtifactsDir(dir);
			await cleanupTemporaryArtifactsDir(dir);
			registry.unregister("Parent");
			await cleanupTemporaryArtifactsDir(dir);
			expect(await Bun.file(path.join(dir, "Parent/Child.jsonl")).text()).toBe("Child\n");
			registry.unregister("Child");
			await cleanupTemporaryArtifactsDir(dir);
			expect(await Bun.file(path.join(dir, "Parent/Child.jsonl")).exists()).toBe(false);
			expect(await Bun.file(path.join(root, "lease-other/Sibling.jsonl")).text()).toBe("Sibling\n");
		} finally {
			await removeWithRetries(root);
		}
	});

	it("keeps nested recovery work if the host exits before the run hands it back", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "registry-recovery-"));
		try {
			const dir = path.join(root, "lease");
			registerTemporaryArtifactsDir(dir);
			const patch = "diff --git a/file.txt b/file.txt\n+unique nested work\n";
			const [saved] = await persistNestedPatches(
				dir,
				"Worker",
				[{ relativePath: "nested/pkg", patch }],
				crypto.randomUUID(),
			);
			// Exercise the exit handler at the producer boundary, before the
			// structured runner has returned and can classify the result.
			sweepTemporaryArtifactsDirs();
			expect(await Bun.file(saved!).text()).toBe(patch);
		} finally {
			await removeWithRetries(root);
		}
	});
});
