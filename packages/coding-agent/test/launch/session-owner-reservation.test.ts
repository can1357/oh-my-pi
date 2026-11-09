import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	isSessionLeaseHeld,
	SessionReservationBusyError,
	SessionReservationUnavailableError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "../helpers/rejection";
import { TERMINAL } from "./session-attach-fixture";
import { sessionAttachEndpoint, type SessionAttachProbe } from "../../src/launch/session-attach";
import * as owner from "../../src/launch/session-owner";

function sequenceProbe(sequence: SessionAttachProbe[]): (sessionId: string) => Promise<SessionAttachProbe> {
	let index = 0;
	return async () => {
		const probe = sequence[Math.min(index, sequence.length - 1)]!;
		index++;
		return probe;
	};
}

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

async function createSession(tempDir: TempDir): Promise<{ sessionId: string; sessionPath: string }> {
	const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
	await creator.ensureOnDisk();
	creator.appendMessage(userTurn("before"));
	const sessionPath = creator.getSessionFile();
	if (!sessionPath) throw new Error("Expected session file");
	await creator.close();
	const sessionId = await readSessionHeaderId(sessionPath);
	if (!sessionId) throw new Error("Expected a session header");
	return { sessionId, sessionPath };
}

describe("strict session reservation", () => {
	it("shares one lease between a reservation and the manager claim that adopts it", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const storage = new FileSessionStorage();

		const reservation = storage.reserveSession(sessionId, sessionPath);
		try {
			expect(isSessionLeaseHeld(sessionId)).toBe(true);
			const releaseManagerHolder = storage.claimSession(sessionId, sessionPath);
			expect(typeof releaseManagerHolder).toBe("function");
			reservation.release();
			expect(isSessionLeaseHeld(sessionId)).toBe(true);
			releaseManagerHolder?.();
			expect(isSessionLeaseHeld(sessionId)).toBe(false);
		} finally {
			reservation.release();
		}
		expect(fs.existsSync(sessionPath)).toBe(true);
	});

	it("refuses with a typed busy error while another process holds the lease", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const holder = await LeaseHolder.spawn(tempDir, sessionId, sessionPath);
		try {
			expect(await holder.held()).toBe("held");

			expect(() => new FileSessionStorage().reserveSession(sessionId, sessionPath)).toThrow(
				SessionReservationBusyError,
			);
			expect(isSessionLeaseHeld(sessionId)).toBe(true);
		} finally {
			await holder.close();
		}

		const reservation = new FileSessionStorage().reserveSession(sessionId, sessionPath);
		reservation.release();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	}, 30_000);

	it("refuses when the journal at the path does not identify the session", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const storage = new FileSessionStorage();

		const foreign = path.join(tempDir.path(), "foreign.jsonl");
		fs.writeFileSync(foreign, `${JSON.stringify({ type: "session", id: "another-session" })}\n`);
		expect(() => storage.reserveSession(sessionId, foreign)).toThrow(SessionReservationUnavailableError);
		expect(isSessionLeaseHeld(sessionId)).toBe(false);

		const unreadable = path.join(tempDir.path(), "unreadable.jsonl");
		fs.writeFileSync(unreadable, "not a session journal\n");
		expect(() => storage.reserveSession(sessionId, unreadable)).toThrow(SessionReservationUnavailableError);
		expect(isSessionLeaseHeld(sessionId)).toBe(false);

		// Legacy claim semantics are untouched: a foreign journal is not this session.
		expect(storage.claimSession(sessionId, foreign)).toBeNull();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
		expect(fs.readFileSync(sessionPath, "utf8")).toContain(sessionId);
	}, 30_000);

	it("refuses to branch a strict owner onto a sibling while another process writes the session", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const before = fs.readFileSync(sessionPath, "utf8");
		const holder = await LeaseHolder.spawn(tempDir, sessionId, sessionPath);
		try {
			expect(await holder.held()).toBe("held");
			const manager = await SessionManager.open(sessionPath, tempDir.path(), new FileSessionStorage(), {
				suppressBreadcrumb: true,
				ownershipPolicy: "require-owner",
			});
			manager.appendMessage(userTurn("strict owner"));
			const failure = await rejectionOf(manager.flush());
			expect((failure as Error).name).toBe("SessionOwnershipConflictError");
			expect((failure as Error).message).toContain(sessionId);
			expect(manager.getSessionFile()).toBe(sessionPath);
			// A strict owner never reports a clean close after losing the journal.
			expect(await rejectionOf(manager.close())).toBe(failure);
		} finally {
			await holder.close();
		}

		expect(jsonlFiles(tempDir.path())).toEqual([sessionPath]);
		expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
	}, 30_000);

	it("keeps brokered cold handoffs strict when another process wins the released lease", async () => {
		using tempDir = TempDir.createSync("@omp-session-handoff-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const before = fs.readFileSync(sessionPath, "utf8");
		const parentReservation = new FileSessionStorage().reserveSession(sessionId, sessionPath);
		parentReservation.release();
		const winner = await LeaseHolder.spawn(tempDir, sessionId, sessionPath);
		let manager: SessionManager | undefined;
		owner.consumeSessionOwnerContext({
			[owner.SESSION_OWNER_CONTEXT_ENV]: JSON.stringify({
				projectDir: tempDir.path(),
				name: "cold-owner",
				id: "broker-generation",
			}),
		});
		try {
			expect(await winner.held()).toBe("held");
			manager = await createSessionManager(
				parseArgs(["--resume", sessionPath]),
				tempDir.path(),
				Settings.isolated(),
			);
			if (!manager) throw new Error("expected cold owner session manager");
			manager.appendMessage(userTurn("losing handoff"));
			const failure = await rejectionOf(manager.flush());
			expect((failure as Error).name).toBe("SessionOwnershipConflictError");
			expect(manager.getSessionId()).toBe(sessionId);
			expect(manager.getSessionFile()).toBe(sessionPath);
			expect(jsonlFiles(tempDir.path())).toEqual([sessionPath]);
			expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
		} finally {
			owner.resetSessionOwnerContextForTest();
			await manager?.close().catch(() => {});
			await winner.close();
		}
	}, 30_000);

	it("releases a reservation the manager never adopts", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const storage = new FileSessionStorage();
		const reservation = storage.reserveSession(sessionId, sessionPath);
		expect(isSessionLeaseHeld(sessionId)).toBe(true);

		const manager = await SessionManager.open(sessionPath, tempDir.path(), storage, {
			suppressBreadcrumb: true,
			ownershipPolicy: "require-owner",
			ownershipReservation: reservation,
		});
		expect(isSessionLeaseHeld(sessionId)).toBe(true);
		await manager.close();

		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("refuses a cold resume whose lease state cannot be determined", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: async () => ({ status: "absent", sessionId, leaseHeld: null }),
		});

		expect(outcome).toEqual({ kind: "refuse", code: "ownership-unknown" });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("attaches to a live owner instead of reserving its session", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: async () => ({ status: "live", sessionId, terminal: TERMINAL }),
		});

		expect(outcome).toEqual({ kind: "attach", terminal: TERMINAL });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("diverts to an owner that published after the reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "live", sessionId, terminal: TERMINAL },
			]),
		});

		expect(outcome).toEqual({ kind: "attach", terminal: TERMINAL });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("diverts to a refuse for an owner that became unreachable after the reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "unreachable", sessionId, endpoint: sessionAttachEndpoint(sessionId) },
			]),
		});

		expect(outcome).toEqual({ kind: "refuse", code: "owner-unreachable" });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("diverts to a refuse when ownership becomes unknown after the reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "unknown", sessionId, reason: "publication is unreadable" },
			]),
		});

		expect(outcome).toEqual({ kind: "refuse", code: "ownership-unknown" });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("diverts to a refuse when the terminal stays unavailable after the reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "live", sessionId },
			]),
		});

		expect(outcome).toEqual({ kind: "refuse", code: "terminal-unavailable" });
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("keeps the reservation when the post-reservation probe sees only itself", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);

		const outcome = await owner.reserveSessionOwnerTarget(sessionId, sessionPath, {
			probe: sequenceProbe([
				{ status: "absent", sessionId, leaseHeld: false },
				{ status: "absent", sessionId, leaseHeld: true },
			]),
		});

		expect(outcome.kind).toBe("reserved");
		if (outcome.kind !== "reserved") throw new Error("expected a reservation");
		expect(isSessionLeaseHeld(sessionId)).toBe(true);
		outcome.reservation.release();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("elects one writer between two processes racing to resume the same session", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const before = fs.readFileSync(sessionPath, "utf8");
		const runDir = tempDir.join("run");
		fs.mkdirSync(runDir);

		const racers = [
			await RaceWriter.spawn(tempDir, sessionId, sessionPath, runDir),
			await RaceWriter.spawn(tempDir, sessionId, sessionPath, runDir),
		];
		try {
			await Promise.all(racers.map(racer => racer.reserve()));

			const outcomes = [await racers[0].report(), await racers[1].report()];
			const winners = outcomes.filter(outcome => outcome.kind === "reserved");
			const losers = outcomes.filter(outcome => outcome.kind === "refuse");
			expect(winners).toHaveLength(1);
			expect(losers).toHaveLength(1);
			expect(losers[0].code).toBe("owner-busy");
			expect(isSessionLeaseHeld(sessionId)).toBe(true);

			// Keep the winner reserved until the loser's write has reached the fence.
			// Otherwise a valid write after the winner closes depends on scheduling.
			const loserIndex = outcomes.findIndex(outcome => outcome.kind === "refuse");
			await racers[loserIndex].write();
			const loser = await racers[loserIndex].report();
			expect(isSessionLeaseHeld(sessionId)).toBe(true);

			const winnerIndex = outcomes.findIndex(outcome => outcome.kind === "reserved");
			await racers[winnerIndex].write();
			const winner = await racers[winnerIndex].report();
			expect(winner?.writeError).toBeUndefined();
			expect(winner?.savedTo).toBe(sessionPath);
			expect(loser?.writeError).toBe("SessionOwnershipConflictError");
			expect(loser?.savedTo).toBeUndefined();

			expect(jsonlFiles(tempDir.path())).toEqual([sessionPath]);
			const journal = fs.readFileSync(sessionPath, "utf8");
			expect(journal.startsWith(before)).toBe(true);
			expect(journal).toContain(`writer ${winner?.pid}`);
			expect(journal).not.toContain(`writer ${loser?.pid}`);
			expect(isSessionLeaseHeld(sessionId)).toBe(false);
		} finally {
			for (const racer of racers) await racer.close();
		}
	}, 60_000);

	// Residual lease-adoption window, documented rather than closed: a live
	// owner that has opened but not yet claimed holds no lease, and a writer
	// that ignores the reservation is not fenced by it. The strict path refuses
	// (previous test); the legacy path still forks a sibling. Closing this
	// needs the peer to reserve too, which is stage 8's CLI cutover.
	it("documents the residual window: a legacy-policy writer still forks around a held reservation", async () => {
		using tempDir = TempDir.createSync("@omp-session-reservation-");
		const { sessionId, sessionPath } = await createSession(tempDir);
		const before = fs.readFileSync(sessionPath, "utf8");
		const runDir = tempDir.join("run");
		fs.mkdirSync(runDir);

		const reservation = new FileSessionStorage().reserveSession(sessionId, sessionPath);
		let report: RaceReport;
		const legacy = await RaceWriter.spawn(tempDir, sessionId, sessionPath, runDir, false);
		try {
			await legacy.write();
			report = await legacy.report();
		} finally {
			await legacy.close();
			reservation.release();
		}

		expect(report.writeError).toBeUndefined();
		expect(report.savedTo).toBeDefined();
		expect(report.savedTo).not.toBe(sessionPath);
		expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
		expect(jsonlFiles(tempDir.path())).toHaveLength(2);
	}, 60_000);
});

function jsonlFiles(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.map(name => path.join(dir, name))
		.sort();
}

const STORAGE_MODULE = path.join(import.meta.dir, "../../src/session/session-storage.ts");

/** A separate OS process that holds the session lease until this test releases it. */
class LeaseHolder {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stdout: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
	#buffered = "";

	private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
		this.#stdout = child.stdout.getReader();
	}

	static async spawn(tempDir: TempDir, sessionId: string, sessionPath: string): Promise<LeaseHolder> {
		const script = tempDir.join("lease-holder.ts");
		await Bun.write(
			script,
			[
				`import { FileSessionStorage } from ${JSON.stringify(STORAGE_MODULE)};`,
				"const reservation = new FileSessionStorage().reserveSession(process.argv[2], process.argv[3]);",
				'process.stdout.write("held\\n");',
				"for await (const line of console) {",
				'	if (line === "release") {',
				"		reservation.release();",
				'		process.stdout.write("released\\n");',
				"	}",
				'	if (line === "exit") break;',
				"}",
			].join("\n"),
		);
		const child = Bun.spawn([process.execPath, script, sessionId, sessionPath], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		return new LeaseHolder(child);
	}

	async held(): Promise<string> {
		return this.#nextLine();
	}

	async close(): Promise<void> {
		this.#child.stdin.write("exit\n");
		this.#child.stdin.end();
		await this.#child.exited;
	}

	async #nextLine(): Promise<string> {
		let newline = this.#buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await this.#stdout.read();
			if (done) throw new Error(`The lease holder exited early: ${await new Response(this.#child.stderr).text()}`);
			this.#buffered += new TextDecoder().decode(value);
			newline = this.#buffered.indexOf("\n");
		}
		const line = this.#buffered.slice(0, newline);
		this.#buffered = this.#buffered.slice(newline + 1);
		return line;
	}
}

const OWNER_MODULE = path.join(import.meta.dir, "../../src/launch/session-owner.ts");
const ATTACH_MODULE = path.join(import.meta.dir, "../../src/launch/session-attach.ts");
const MANAGER_MODULE = path.join(import.meta.dir, "../../src/session/session-manager.ts");

interface RaceReport {
	kind: "reserved" | "refuse";
	code?: string;
	pid: number;
	savedTo?: string;
	writeError?: string;
}

/**
 * One process of a cold-resume race. Reservation and writing are separate
 * barriers so the test can hold the winner's lease across the loser's first
 * write: that is the moment the fence has to hold, not session open.
 */
class RaceWriter {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #stdout: { read(): Promise<{ done: boolean; value?: Uint8Array }> };
	#buffered = "";

	private constructor(child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
		this.#stdout = child.stdout.getReader();
	}

	static async spawn(
		tempDir: TempDir,
		sessionId: string,
		sessionPath: string,
		runDir: string,
		strict = true,
	): Promise<RaceWriter> {
		const script = tempDir.join(`race-writer-${Math.random().toString(16).slice(2)}.ts`);
		await Bun.write(
			script,
			[
				`import * as path from "node:path";`,
				`import { reserveSessionOwnerTarget } from ${JSON.stringify(OWNER_MODULE)};`,
				`import { probeSessionAttach } from ${JSON.stringify(ATTACH_MODULE)};`,
				`import { SessionManager } from ${JSON.stringify(MANAGER_MODULE)};`,
				`import { FileSessionStorage } from ${JSON.stringify(STORAGE_MODULE)};`,
				"const [sessionId, sessionPath, runDir, mode] = process.argv.slice(2);",
				'const strict = mode === "strict";',
				"const report = { kind: 'refuse', code: undefined, pid: process.pid, savedTo: undefined, writeError: undefined };",
				"let reservation;",
				"const emit = () => process.stdout.write(JSON.stringify(report) + String.fromCharCode(10));",
				"for await (const line of console) {",
				'	if (line === "reserve") {',
				"		const outcome = await reserveSessionOwnerTarget(sessionId, sessionPath, {",
				"			probe: id => probeSessionAttach(id, { endpointDir: runDir, timeoutMs: 500 }),",
				"		});",
				"		report.kind = outcome.kind;",
				'		if (outcome.kind === "refuse") report.code = outcome.code;',
				'		if (outcome.kind === "reserved") reservation = outcome.reservation;',
				"		emit();",
				"		continue;",
				"	}",
				'	if (line === "write") {',
				"		const options = { suppressBreadcrumb: true };",
				"		if (strict) {",
				'			options.ownershipPolicy = "require-owner";',
				"			options.ownershipReservation = reservation;",
				"		}",
				"		const manager = await SessionManager.open(sessionPath, path.dirname(sessionPath), new FileSessionStorage(), options);",
				"		try {",
				"			manager.appendMessage({ role: 'user', content: `writer ${process.pid}`, timestamp: Date.now() });",
				"			await manager.flush();",
				"			report.savedTo = manager.getSessionFile();",
				"		} catch (error) {",
				"			report.writeError = error.name;",
				"		}",
				"		try { await manager.close(); } catch {}",
				"		reservation?.release();",
				"		emit();",
				"		continue;",
				"	}",
				"	break;",
				"}",
			].join("\n"),
		);
		const child = Bun.spawn(
			[process.execPath, script, sessionId, sessionPath, runDir, strict ? "strict" : "legacy"],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: process.env,
			},
		);
		return new RaceWriter(child);
	}

	async reserve(): Promise<void> {
		this.#send("reserve");
	}

	async write(): Promise<void> {
		this.#send("write");
	}

	#send(phase: string): void {
		this.#child.stdin.write(`${phase}\n`);
		this.#child.stdin.flush();
	}

	async report(): Promise<RaceReport> {
		let newline = this.#buffered.indexOf("\n");
		while (newline === -1) {
			const { done, value } = await this.#stdout.read();
			if (done) throw new Error(`The race writer exited early: ${await new Response(this.#child.stderr).text()}`);
			this.#buffered += new TextDecoder().decode(value);
			newline = this.#buffered.indexOf("\n");
		}
		const line = this.#buffered.slice(0, newline);
		this.#buffered = this.#buffered.slice(newline + 1);
		return JSON.parse(line) as RaceReport;
	}

	async close(): Promise<void> {
		this.#child.stdin.end();
		await this.#child.exited;
	}
}
