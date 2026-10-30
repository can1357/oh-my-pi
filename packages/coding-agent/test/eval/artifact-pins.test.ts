import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import {
	ArtifactPinOwner,
	answerArtifactRequest,
	releaseArtifactRoots,
	resolveSettledArtifact,
	takePinnedArtifact,
} from "../../src/eval/artifact-readiness";
import { settledArtifactOf } from "../../src/eval/artifact-wire";
import { createHelpers } from "../../src/eval/js/shared/helpers";
import { registerArtifactsDir } from "../../src/internal-urls/registry-helpers";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

/**
 * An answer about `artifact://<n>` carries a pin on the file it is about, for
 * the reader to take if the name stops meaning that file before it reads it.
 * The pin is a claim with an owner and a lifetime: charged to the session that
 * asked, taken by one reader, given back once, and ended with the cell, the
 * kernel or the session it was asked through.
 */

/** Descriptors this process holds on files under `dir`: the pins, counted where they live. */
function openUnder(dir: string): number {
	let open = 0;
	for (const fd of fs.readdirSync("/proc/self/fd")) {
		try {
			if (fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${dir}/`)) open++;
		} catch {
			// Closed between the listing and the readlink.
		}
	}
	return open;
}

function sessionReading(dir: string, id: string): ToolSession {
	return { getArtifactsDir: () => dir, getSessionId: () => id } as unknown as ToolSession;
}

function artifacts(tempDir: TempDir, name: string, count: number): string {
	const dir = path.join(tempDir.path(), name);
	fs.mkdirSync(dir, { recursive: true });
	for (let n = 0; n < count; n++) fs.writeFileSync(path.join(dir, `${n}.read.log`), `ORIGINAL ${n}`);
	return dir;
}

afterEach(async () => {
	await releaseArtifactRoots();
});

describe.skipIf(process.platform !== "linux")("eval artifact pins", () => {
	it("gives a lapsed pin back once, so the quota stays thirty-two", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const dir = artifacts(tempDir, "a", 140);
		const session = sessionReading(dir, "lapse");
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			for (let n = 0; n < 32; n++) await resolveSettledArtifact(session, String(n), dir);
			// Every one of those is past its lease now. Each new answer may take
			// one lapsed slot, and only one: thirty-two more, then a refusal.
			now = 3_000;
			let admitted = 0;
			let refusal = "";
			for (let n = 32; n < 140; n++) {
				try {
					await resolveSettledArtifact(session, String(n), dir);
					admitted++;
				} catch (error) {
					refusal = String(error);
					break;
				}
			}
			expect(admitted).toBe(32);
			expect(refusal).toContain("32 artifact answers are outstanding");
			expect(openUnder(dir)).toBe(32);
		} finally {
			clock.mockRestore();
		}
	});

	it("charges the session that reads, not the session whose artifacts it reads", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const owned = artifacts(tempDir, "owner", 40);
		const empty = artifacts(tempDir, "reader", 0);
		const owner = sessionReading(owned, "owner");
		const reader = sessionReading(empty, "reader");
		const unregister = registerArtifactsDir(owned);
		try {
			// The reader's own directory has none of these: each is found in the
			// owner's, by the search a session on its own directory may make.
			for (let n = 0; n < 32; n++) {
				expect((await resolveSettledArtifact(reader, String(n), empty))?.path).toBe(
					path.join(owned, `${n}.read.log`),
				);
			}
			await expect(resolveSettledArtifact(reader, "32", empty)).rejects.toThrow(
				"32 artifact answers are outstanding",
			);
			expect((await resolveSettledArtifact(owner, "33", owned))?.path).toBe(path.join(owned, "33.read.log"));
		} finally {
			unregister();
		}
	});

	it("lets one reader take a pin and refuses the next, instead of sharing its descriptor", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const dir = artifacts(tempDir, "a", 0);
		fs.writeFileSync(path.join(dir, "0.read.log"), "X".repeat(2_000_000));
		const answer = await resolveSettledArtifact(sessionReading(dir, "take"), "0", dir);
		const file = answer?.file;
		if (!file) throw new Error("the answer holds no pin");

		const taken = await Promise.allSettled([takePinnedArtifact(file), takePinnedArtifact(file)]);
		const read = taken.filter(outcome => outcome.status === "fulfilled");
		const refused = taken.filter(outcome => outcome.status === "rejected");
		expect(read.map(outcome => outcome.value.text?.length)).toEqual([2_000_000]);
		expect(refused.map(outcome => String(outcome.reason))).toEqual([expect.stringContaining("no longer held open")]);
		expect(openUnder(dir)).toBe(0);
	});

	it("ends a pin with the owner it was answered through, and an ended owner holds no more", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const dir = artifacts(tempDir, "a", 2);
		const session = sessionReading(dir, "owner-ends");
		const cell = new ArtifactPinOwner();
		const answer = await resolveSettledArtifact(session, "0", dir, undefined, undefined, false, undefined, {
			owner: cell,
		});
		expect(openUnder(dir)).toBe(1);

		await cell.end();
		expect(openUnder(dir)).toBe(0);
		await expect(takePinnedArtifact(answer?.file ?? "")).rejects.toThrow("no longer held open");
		await expect(
			resolveSettledArtifact(session, "1", dir, undefined, undefined, false, undefined, { owner: cell }),
		).rejects.toThrow("has ended");
		expect(openUnder(dir)).toBe(0);
	});

	it("lets an abandoned pin lapse at its lease with nobody asking for the slot", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const dir = artifacts(tempDir, "a", 1);
		vi.useFakeTimers();
		try {
			const answer = await resolveSettledArtifact(sessionReading(dir, "abandoned"), "0", dir);
			expect(openUnder(dir)).toBe(1);
			// Nothing else happens: no read, no pressure, no release.
			vi.advanceTimersByTime(2_000);
			await expect(takePinnedArtifact(answer?.file ?? "")).rejects.toThrow("no longer held open");
		} finally {
			vi.useRealTimers();
		}
		// The claim is gone at once; its descriptor closes as soon as the close lands.
		for (let turn = 0; turn < 1_000 && openUnder(dir) > 0; turn++) await scheduler.yield();
		expect(openUnder(dir)).toBe(0);
	});

	it("answers a locate with the file and holds nothing for it", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const dir = artifacts(tempDir, "a", 1);
		const located = await answerArtifactRequest(sessionReading(dir, "locate"), { op: "locate", id: "0", root: dir });
		expect(located?.path).toBe(path.join(dir, "0.read.log"));
		expect(located?.file).toBeUndefined();
		expect(openUnder(dir)).toBe(0);
	});

	it("gives back every pin a session holds when the session is disposed", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const authStorage = createInMemoryAuthStorage();
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		const dir = artifacts(tempDir, "a", 33);
		const reader = sessionReading(dir, sessionManager.getSessionId());
		try {
			for (let n = 0; n < 32; n++) await resolveSettledArtifact(reader, String(n), dir);
			expect(openUnder(dir)).toBe(32);
			await session.dispose();
			expect(openUnder(dir)).toBe(0);
			// The quota went with the descriptors.
			expect((await resolveSettledArtifact(reader, "32", dir))?.path).toBe(path.join(dir, "32.read.log"));
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("gives a read's pin back only after that read, never on another read's behalf", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const dir = artifacts(tempDir, "a", 2);
		const session = sessionReading(dir, "overlap");
		// One cell's roots, the same object for every read it makes, as a run has.
		const roots: Record<string, string> = { artifact: dir };
		const helpers = createHelpers({
			cwd: () => tempDir.path(),
			env: new Map(),
			localRoots: () => roots,
			emitStatus: () => {},
			resolveArtifact: async request => settledArtifactOf(await answerArtifact(session, request)),
		});
		const open = fsp.open;
		const reached = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let paused = false;
		const hook = spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof open>) => {
			// The first read stops between its answer and its open.
			if (String(args[0]) === path.join(dir, "0.read.log") && !paused) {
				paused = true;
				reached.resolve();
				await resume.promise;
			}
			return await open(...args);
		}) as typeof open);
		try {
			const first = helpers.read("artifact://0");
			await reached.promise;
			// A second read runs to completion meanwhile, and gives its own pin back.
			expect(await helpers.read("artifact://1")).toBe("ORIGINAL 1");
			// Then the first read's name stops meaning its file.
			fs.renameSync(path.join(dir, "0.read.log"), path.join(dir, "moved"));
			fs.writeFileSync(path.join(dir, "0.read.log"), "WRONG FOREIGN");
			resume.resolve();
			expect(await first).toBe("ORIGINAL 0");
			expect(openUnder(dir)).toBe(0);
		} finally {
			resume.resolve();
			hook.mockRestore();
		}
	});
});

/** The bridge value a host gives for `request`, as the JavaScript host sends it. */
async function answerArtifact(
	session: ToolSession,
	request: Parameters<typeof answerArtifactRequest>[1],
): Promise<unknown> {
	const answer = await answerArtifactRequest(session, request);
	return answer ? { text: answer.path, details: answer } : "";
}
