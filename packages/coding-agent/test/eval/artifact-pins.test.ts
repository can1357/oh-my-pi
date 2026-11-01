import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
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
	artifactPinCeiling,
	artifactPinCeilingFor,
	holdArtifactRoot,
	releaseArtifactRoots,
	resolveSettledArtifact,
	setArtifactPinCeilingForTests,
	takePinnedArtifact,
} from "../../src/eval/artifact-readiness";
import {
	type ArtifactRequest,
	artifactRequestOf,
	EVAL_ARTIFACT_ROOT_TOKEN,
	settledArtifactOf,
} from "../../src/eval/artifact-wire";
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

/** A real `AgentSession`, whose `dispose()` is what ends its pin account. */
function agentSession(tempDir: TempDir) {
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
	return { session, sessionManager, authStorage };
}

afterEach(async () => {
	await releaseArtifactRoots();
});

describe("the pin ceiling", () => {
	it("is a sixty-fourth of the open-descriptor limit, and never fewer than thirty-two", () => {
		expect(artifactPinCeilingFor(524_288)).toBe(8_192);
		expect(artifactPinCeilingFor(1_048_576)).toBe(16_384);
		expect(artifactPinCeilingFor(4_096)).toBe(64);
		expect(artifactPinCeilingFor(1_024)).toBe(32);
		expect(artifactPinCeilingFor(256)).toBe(32);
		expect(artifactPinCeilingFor(undefined)).toBe(32);
	});

	it.skipIf(process.platform !== "linux")("is derived from this process's own soft limit", () => {
		const line = fs
			.readFileSync("/proc/self/limits", "utf8")
			.split("\n")
			.find(entry => entry.startsWith("Max open files"));
		const soft = Number(line?.slice("Max open files".length).trim().split(/\s+/)[0]);
		expect(artifactPinCeiling()).toBe(artifactPinCeilingFor(soft));
	});
});

describe.skipIf(process.platform !== "linux")("eval artifact pins", () => {
	// These tests are about admission at the ceiling, so they fix it at the floor
	// rather than at whatever this machine's descriptor limit derives.
	let restoreCeiling: () => void = () => {};
	beforeEach(() => {
		restoreCeiling = setArtifactPinCeilingForTests(32);
	});
	afterEach(() => restoreCeiling());

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
		const answer = await resolveSettledArtifact(session, "0", dir, undefined, undefined, { owner: cell });
		expect(openUnder(dir)).toBe(1);

		await cell.end();
		expect(openUnder(dir)).toBe(0);
		await expect(takePinnedArtifact(answer?.file ?? "")).rejects.toThrow("no longer held open");
		await expect(resolveSettledArtifact(session, "1", dir, undefined, undefined, { owner: cell })).rejects.toThrow(
			"has ended",
		);
		expect(openUnder(dir)).toBe(0);
	});

	it("refuses a take at the lease boundary even before the lease timer has run", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const dir = artifacts(tempDir, "a", 2);
		const session = sessionReading(dir, "boundary");
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			const inside = await resolveSettledArtifact(session, "0", dir);
			const boundary = await resolveSettledArtifact(session, "1", dir);
			// The real lease timer has not run: only the clock says the lease is over.
			now = 1_999;
			expect((await takePinnedArtifact(inside?.file ?? "")).text).toBe("ORIGINAL 0");
			now = 2_000;
			await expect(takePinnedArtifact(boundary?.file ?? "")).rejects.toThrow("no longer held open");
		} finally {
			clock.mockRestore();
		}
		for (let turn = 0; turn < 1_000 && openUnder(dir) > 0; turn++) await scheduler.yield();
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

	it("gives back every pin a session holds when the session is disposed, and a revived id starts anew", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const { session, sessionManager, authStorage } = agentSession(tempDir);
		const dir = artifacts(tempDir, "a", 33);
		const reader = sessionReading(dir, sessionManager.getSessionId());
		try {
			for (let n = 0; n < 32; n++) await resolveSettledArtifact(reader, String(n), dir);
			expect(openUnder(dir)).toBe(32);
			await session.dispose();
			expect(openUnder(dir)).toBe(0);
			// A session revived under the same id reads again, on an account of its own.
			expect((await resolveSettledArtifact(reader, "32", dir))?.path).toBe(path.join(dir, "32.read.log"));
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("refuses an answer still on its way when its session is disposed, instead of pinning after the disposal", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const { session, sessionManager, authStorage } = agentSession(tempDir);
		const dir = artifacts(tempDir, "a", 1);
		// No cell or kernel owner: the session's own lifetime is all that ends it.
		const reader = sessionReading(dir, sessionManager.getSessionId());
		const open = fsp.open;
		const opened = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const hook = spyOn(fs.promises, "open").mockImplementation((async (...args: Parameters<typeof open>) => {
			const handle = await open(...args);
			// The file is open; its charge has not happened yet.
			if (String(args[0]).endsWith("/0.read.log")) {
				opened.resolve();
				await resume.promise;
			}
			return handle;
		}) as typeof open);
		try {
			const answering = answerArtifactRequest(reader, { op: "answer", id: "0", root: dir });
			await opened.promise;
			await session.dispose();
			resume.resolve();
			await expect(answering).rejects.toThrow("the session this read belongs to has ended");
			expect(openUnder(dir)).toBe(0);
		} finally {
			resume.resolve();
			hook.mockRestore();
			await session.dispose();
			authStorage.close();
		}
	});

	it("refuses a first read's answer issued against another directory than the one the cell bound, and reads its own", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const dir = path.join(tempDir.path(), "a");
		const session = sessionReading(dir, "first-reads");
		// A cell started before its directory existed: no token on its roots.
		const roots: Record<string, string> = { artifact: dir };
		const asked: ArtifactRequest[] = [];
		const second = Promise.withResolvers<void>();
		let answers = 0;
		const helpers = createHelpers({
			cwd: () => tempDir.path(),
			env: new Map(),
			localRoots: () => roots,
			emitStatus: () => {},
			resolveArtifact: async request => {
				asked.push(request);
				// The second first-read reaches the host only after the directory is replaced.
				if (request.op === "answer" && ++answers === 2) await second.promise;
				return settledArtifactOf(await answerArtifact(session, request));
			},
		});
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "0.read.log"), "ORIGINAL");
		const first = helpers.read("artifact://0");
		const later = helpers.read("artifact://0");
		expect(await first).toBe("ORIGINAL");
		fs.renameSync(dir, path.join(tempDir.path(), "saved"));
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "0.read.log"), "WRONG FOREIGN");
		second.resolve();
		expect(await later).toBe("ORIGINAL");
		const bound = roots[EVAL_ARTIFACT_ROOT_TOKEN];
		expect(bound).toStartWith("root-");
		// Both first reads asked with no token; the conflicting answer was given back and asked again through the bound hold.
		expect(asked.filter(request => request.op === "answer").map(request => request.token)).toEqual([
			undefined,
			undefined,
			bound,
		]);
		expect(openUnder(path.join(tempDir.path(), "saved"))).toBe(0);
		expect(openUnder(dir)).toBe(0);
	});

	it("fails a read loudly when even the cell's own hold answers from another directory", async () => {
		using tempDir = TempDir.createSync("@omp-eval-pins-");
		const roots: Record<string, string> = { artifact: tempDir.path(), [EVAL_ARTIFACT_ROOT_TOKEN]: "root-mine" };
		const released: string[] = [];
		let answered = 0;
		const helpers = createHelpers({
			cwd: () => tempDir.path(),
			env: new Map(),
			localRoots: () => roots,
			emitStatus: () => {},
			// A host that answers from some other hold whatever it is asked.
			resolveArtifact: async request => {
				if (request.op === "release") released.push(request.file);
				if (request.op !== "answer") return null;
				answered++;
				const file = path.join(tempDir.path(), "0.read.log");
				return { path: file, device: "0", inode: "0", file: `file-${answered}`, root: "root-other" };
			},
		});
		await expect(helpers.read("artifact://0")).rejects.toThrow(
			"answered from a directory other than the one this cell reads",
		);
		// Neither answer was read; both pins went back.
		expect(released).toEqual(["file-1", "file-2"]);
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

/**
 * The wire takes any string for a request's fields, so an empty one arrives at
 * the host as present. Each field is read there by one rule; an empty string
 * is not a second, quieter way of leaving it out.
 */
describe.skipIf(process.platform !== "linux")("artifact requests with an empty field", () => {
	/**
	 * The host's answer to `sent` as a reader puts it on the wire, or what it
	 * refused with. An answer is named by the file it is about, not by what its
	 * path reaches now: a reader checks the object it opens against this.
	 */
	async function ask(session: ToolSession, sent: Record<string, string>): Promise<string> {
		const request = artifactRequestOf(sent);
		if (!request) return "refused at the wire";
		try {
			const answer = await answerArtifactRequest(session, request);
			return answer ? `answered inode ${answer.inode}, root ${answer.root}` : "answered nothing";
		} catch (error) {
			return `refused: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	const inodeOf = (file: string) => String(fs.statSync(file).ino);

	it("refuses an empty token like any token that names no hold, once the name reaches another directory", async () => {
		using tempDir = TempDir.createSync("@omp-eval-empty-");
		const dir = artifacts(tempDir, "a", 8);
		const session = sessionReading(dir, "empty-token");
		const hold = await holdArtifactRoot(dir);
		if (hold === undefined) throw new Error("the directory could not be held");
		const original = inodeOf(path.join(dir, "7.read.log"));
		fs.renameSync(dir, path.join(tempDir.path(), "moved"));
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "7.read.log"), "WRONG FOREIGN");

		expect(await ask(session, { op: "locate", id: "7", root: dir, token: hold })).toBe(
			`answered inode ${original}, root ${hold}`,
		);
		expect(await ask(session, { op: "locate", id: "7", root: dir, token: "root-nobody-holds" })).toStartWith(
			"refused: the artifacts directory this cell was started on is no longer held open",
		);
		expect(await ask(session, { op: "locate", id: "7", root: dir, token: "" })).toStartWith(
			"refused: the artifacts directory this cell was started on is no longer held open",
		);
	});

	it("refuses an empty artifact id instead of answering with the first dotfile", async () => {
		using tempDir = TempDir.createSync("@omp-eval-empty-");
		const dir = artifacts(tempDir, "a", 1);
		fs.writeFileSync(path.join(dir, ".omp-reserved"), "NOT AN ARTIFACT");
		const session = sessionReading(dir, "empty-id");

		expect(await ask(session, { op: "locate", id: "", root: dir })).toStartWith("refused: ");
		expect(await ask(session, { op: "locate", id: "0", root: dir })).toStartWith(
			`answered inode ${inodeOf(path.join(dir, "0.read.log"))},`,
		);
	});

	it("refuses an empty artifacts directory instead of reading it as no directory at all", async () => {
		using tempDir = TempDir.createSync("@omp-eval-empty-");
		const dir = artifacts(tempDir, "a", 1);
		const session = sessionReading(dir, "empty-root");

		expect(await ask(session, { op: "locate", id: "0", root: "" })).toStartWith("refused: ");
	});
});

describe("an artifact request at the host", () => {
	it("reads its op once, so the op that picks its parser is the op it parses", () => {
		// No bridge delivers a getter; this one says `take` and then `__proto__`,
		// which no parser answers to, so a second read cannot go unnoticed.
		let reads = 0;
		const sent = {
			get op() {
				reads++;
				return reads === 1 ? "take" : "__proto__";
			},
			file: "file-1",
		};
		expect(artifactRequestOf(sent)).toEqual({ op: "take", file: "file-1" });
		expect(reads).toBe(1);
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
