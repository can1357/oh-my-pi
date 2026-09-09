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
	hasResolvableTranscript,
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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
});
