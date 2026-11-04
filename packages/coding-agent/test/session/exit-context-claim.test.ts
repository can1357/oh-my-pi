/**
 * The exit-intent claim protocol under every interleaving its actors can
 * produce: several reader passes of one process, a sender publishing further
 * words, and a reader dying at any step boundary.
 *
 * `claimExitIntent` asks for its filesystem and board work one step at a time,
 * so a model of both can answer those steps here. A scheduler walks every
 * sequence of moves (advance a reader, kill a reader, publish a word) from the
 * start state, replaying each prefix, and checks the protocol's invariants
 * after every move and again once the dust has settled. Killing a reader drops
 * it with its pending step unperformed, which is what a terminated thread
 * leaves behind; stalling one is the scheduler simply running other actors
 * first, so a reader that wakes long after a takeover would have fired is a
 * schedule like any other.
 */
import { describe, expect, it } from "bun:test";
import {
	claimExitIntent,
	type ExitContextClaim,
	type ExitContextClaimEffect,
	type ExitContextClaimOutcome,
	claimedCopyPrefix,
} from "@oh-my-pi/pi-coding-agent/session/exit-context-claim";
import type { ExitContextWord } from "@oh-my-pi/pi-coding-agent/session/exit-context-protocol";

const PID = 4242;
const DIR = "/run/exit-intent";
const INTENT_PATH = `${DIR}/${PID}`;
const COPY_PREFIX = `${DIR}/${claimedCopyPrefix(PID)}`;
/** Epoch ms the modelled process started; anything older was left by an earlier process with this pid. */
const PROCESS_START_MS = 1_000;

interface ModelFile {
	text: string;
	mtimeMs: number;
}

/** The intent directory and the board of one modelled process. */
class World {
	files = new Map<string, ModelFile>();
	recorded: ExitContextWord | undefined;
	/** Every word a sender published at the intent path, oldest first. */
	published: ExitContextWord[] = [];
	violations: string[] = [];
	#clock = PROCESS_START_MS;

	/** A sender's `omp session exit-intent`: one atomic replacement of the intent file. */
	publish(word: string): void {
		const mtimeMs = ++this.#clock;
		this.files.set(INTENT_PATH, { text: `${word}\n`, mtimeMs });
		this.published.push({ word, mtimeMs });
	}

	/** A file an earlier process with this pid left behind; its word must never be recorded. */
	seedStale(path: string, text: string): void {
		this.files.set(path, { text, mtimeMs: PROCESS_START_MS - 500 });
	}

	copies(): string[] {
		return [...this.files.keys()].filter(path => path.startsWith(COPY_PREFIX));
	}

	fail(invariant: string, detail: string): void {
		this.violations.push(`${invariant}: ${detail}`);
	}

	perform(reader: Reader, effect: ExitContextClaimEffect): ExitContextClaimOutcome {
		switch (effect.kind) {
			case "recorded":
				if (effect.intentPath !== INTENT_PATH) this.fail("I1b", `read the board under ${effect.intentPath}`);
				return { kind: "recorded", word: this.recorded };
			case "take": {
				if (effect.intentPath !== INTENT_PATH) this.fail("I1b", `renamed ${effect.intentPath}`);
				if (effect.claimedPath !== reader.claimedPath) {
					this.fail("I1b", `${reader.id} renamed the intent file to ${effect.claimedPath}`);
				}
				if (this.files.has(effect.claimedPath)) this.fail("I1b", `${effect.claimedPath} was overwritten`);
				const file = this.files.get(INTENT_PATH);
				if (!file) return { kind: "take", taken: false };
				this.files.delete(INTENT_PATH);
				this.files.set(effect.claimedPath, file);
				return { kind: "take", taken: true };
			}
			case "list":
				return { kind: "list", claimedPaths: this.copies() };
			case "read": {
				if (!effect.claimedPath.startsWith(COPY_PREFIX)) this.fail("I1b", `read ${effect.claimedPath}`);
				const file = this.files.get(effect.claimedPath);
				if (file) reader.read.add(effect.claimedPath);
				return { kind: "read", file: file && { ...file } };
			}
			case "record": {
				if (effect.word.mtimeMs < PROCESS_START_MS) this.fail("I5", `recorded a stale word ${effect.word.word}`);
				if (!this.published.some(word => word.mtimeMs === effect.word.mtimeMs && word.word === effect.word.word)) {
					this.fail("I7", `recorded ${effect.word.word}, which no sender published`);
				}
				if (!this.recorded || effect.word.mtimeMs > this.recorded.mtimeMs) this.recorded = effect.word;
				return { kind: "record", word: this.recorded };
			}
			case "remove": {
				if (!effect.claimedPath.startsWith(COPY_PREFIX)) this.fail("I1b", `deleted ${effect.claimedPath}`);
				if (!reader.read.has(effect.claimedPath)) {
					this.fail("I3", `${reader.id} deleted ${effect.claimedPath} without reading it`);
				}
				this.files.delete(effect.claimedPath);
				return { kind: "remove" };
			}
		}
	}

	/** I1, I5, I6, I7 after every single step: nothing is lost while the protocol runs. */
	check(recordedBefore: ExitContextWord | undefined): void {
		const latest = this.published.at(-1);
		if (latest) {
			const onDisk = [...this.files.values()].some(file => file.mtimeMs === latest.mtimeMs);
			if (!onDisk && this.recorded?.mtimeMs !== latest.mtimeMs) {
				this.fail("I1", `the word ${latest.word} is neither on disk nor recorded`);
			}
		}
		if (this.recorded && this.recorded.mtimeMs < PROCESS_START_MS) {
			this.fail("I5", `${this.recorded.word} is older than the process`);
		}
		if (recordedBefore && (this.recorded?.mtimeMs ?? -1) < recordedBefore.mtimeMs) {
			this.fail("I6", `the recorded word went back from ${recordedBefore.word} to ${this.recorded?.word}`);
		}
	}
}

/** One pass of the protocol, stepped by the scheduler. */
class Reader {
	claim: ExitContextClaim;
	pending: ExitContextClaimEffect | undefined;
	done = false;
	alive = true;
	answer: string | undefined;
	read = new Set<string>();
	claimedPath: string;

	constructor(readonly id: string) {
		this.claimedPath = `${COPY_PREFIX}${id}`;
		this.claim = claimExitIntent({
			intentPath: INTENT_PATH,
			claimedPath: this.claimedPath,
			processStartMs: PROCESS_START_MS,
		});
		const first = this.claim.next();
		if (first.done) this.finish(first.value);
		else this.pending = first.value;
	}

	finish(answer: string | undefined): void {
		this.done = true;
		this.pending = undefined;
		this.answer = answer;
	}

	step(world: World): void {
		if (!this.pending) throw new Error(`${this.id} has nothing to do`);
		const before = world.recorded;
		const next = this.claim.next(world.perform(this, this.pending));
		if (next.done) this.finish(next.value);
		else this.pending = next.value;
		world.check(before);
	}

	runToEnd(world: World): void {
		while (!this.done) this.step(world);
	}
}

type Move = { kind: "step" | "kill"; reader: number } | { kind: "publish" };

interface Scenario {
	/** Reader passes that run at the same time, all from the start of the schedule. */
	readers: number;
	/** Words the sender may publish during the schedule, in order. */
	words: string[];
	/** Reader deaths one schedule may contain. */
	kills: number;
	/** The directory and board before any pass runs. */
	start: (world: World) => void;
	/** What this scenario demands of the end state, beyond the invariants every schedule is held to. */
	settled?: (world: World) => void;
}

interface Run {
	world: World;
	readers: Reader[];
	kills: number;
	words: string[];
}

function replay(scenario: Scenario, moves: Move[]): Run {
	const world = new World();
	scenario.start(world);
	const run: Run = {
		world,
		readers: Array.from({ length: scenario.readers }, (_, index) => new Reader(`p${index}`)),
		kills: scenario.kills,
		words: [...scenario.words],
	};
	for (const move of moves) {
		switch (move.kind) {
			case "step":
				run.readers[move.reader]!.step(world);
				break;
			case "kill":
				run.readers[move.reader]!.alive = false;
				run.kills--;
				break;
			case "publish":
				world.publish(run.words.shift()!);
				world.check(world.recorded);
				break;
		}
	}
	return run;
}

function legalMoves(run: Run): Move[] {
	const moves: Move[] = [];
	run.readers.forEach((reader, index) => {
		if (!reader.alive || reader.done) return;
		moves.push({ kind: "step", reader: index });
		if (run.kills > 0) moves.push({ kind: "kill", reader: index });
	});
	if (run.words.length > 0) moves.push({ kind: "publish" });
	return moves;
}

/**
 * What must hold once every actor has stopped and the next exits have read:
 * no copy is left, every published word is recorded, still on disk, or older
 * than one that is, and a process that was told a word knows one.
 */
function settle(run: Run, scenario: Scenario): void {
	const { world } = run;
	new Reader("recovery-1").runToEnd(world);
	const second = new Reader("recovery-2");
	second.runToEnd(world);
	if (world.copies().length > 0) world.fail("I2", `copies left on disk: ${world.copies().join(", ")}`);
	const recorded = world.recorded;
	const onDisk = world.files.get(INTENT_PATH);
	for (const word of world.published) {
		const kept =
			recorded?.mtimeMs === word.mtimeMs ||
			onDisk?.mtimeMs === word.mtimeMs ||
			(recorded?.mtimeMs ?? -1) > word.mtimeMs ||
			(onDisk?.mtimeMs ?? -1) > word.mtimeMs;
		if (!kept) world.fail("I1", `${word.word} was lost: recorded ${recorded?.word}, on disk ${onDisk?.text}`);
	}
	if (world.published.length > 0 && !recorded) world.fail("I1", "a word was published and none is recorded");
	if (second.answer !== recorded?.word) {
		world.fail("I6", `a later exit records ${second.answer}, not the recorded ${recorded?.word}`);
	}
	for (const reader of run.readers) {
		if (reader.answer === undefined) continue;
		if (!world.published.some(word => word.word === reader.answer)) {
			world.fail("I7", `${reader.id} recorded ${reader.answer}, which no sender published`);
		}
	}
	scenario.settled?.(world);
}

/** Walk every schedule of `scenario`, replaying each prefix, and report what the protocol broke. */
function explore(scenario: Scenario): { schedules: number; states: number; violations: string[] } {
	const violations = new Set<string>();
	let schedules = 0;
	let states = 0;
	const walk = (prefix: Move[]): void => {
		states++;
		const run = replay(scenario, prefix);
		const moves = legalMoves(run);
		if (moves.length === 0) {
			schedules++;
			settle(run, scenario);
			for (const violation of run.world.violations) violations.add(violation);
			return;
		}
		for (const move of moves) walk([...prefix, move]);
	};
	walk([]);
	return { schedules, states, violations: [...violations] };
}

describe("exit-intent claim schedules", () => {
	it("loses no word and leaves no copy when one reader dies anywhere and the sender publishes again", () => {
		const result = explore({
			readers: 1,
			words: ["restart", "stop"],
			kills: 1,
			start: world => world.publish("move"),
		});
		expect(result.violations).toEqual([]);
		expect(result.schedules).toBeGreaterThan(100);
	});

	it("loses no word when two readers race, both can die, and the sender publishes again", () => {
		const result = explore({
			readers: 2,
			words: ["stop"],
			kills: 2,
			start: world => world.publish("restart"),
		});
		expect(result.violations).toEqual([]);
		expect(result.schedules).toBeGreaterThan(500_000);
	}, 120_000);

	it("never records or keeps what an earlier process with this pid left", () => {
		const stale = (world: World): void => {
			world.seedStale(INTENT_PATH, "move\n");
			world.seedStale(`${COPY_PREFIX}dead-process`, "stop\n");
		};
		const racing = explore({
			readers: 2,
			words: [],
			kills: 1,
			start: stale,
			// Nothing live was ever published: both leftovers go and the process records nothing.
			settled: world => {
				if (world.files.size > 0) world.fail("I5", `left ${[...world.files.keys()].join(", ")}`);
				if (world.recorded) world.fail("I5", `recorded the stale word ${world.recorded.word}`);
			},
		});
		expect(racing.violations).toEqual([]);
		expect(racing.schedules).toBeGreaterThan(40_000);
		const withFreshWords = explore({
			readers: 1,
			words: ["restart", "stop"],
			kills: 1,
			// A word a sender published stands; neither leftover is ever recorded (I7) or kept (I2).
			start: stale,
		});
		expect(withFreshWords.violations).toEqual([]);
		expect(withFreshWords.schedules).toBeGreaterThan(200);
	}, 120_000);

	it("leaves a word published after one is recorded on disk, for the next process", () => {
		const result = explore({
			readers: 2,
			words: ["stop"],
			kills: 1,
			start: world => {
				world.publish("restart");
				world.recorded = world.published[0];
				world.files.delete(INTENT_PATH);
			},
			// The recorded word stands, and the later one is untouched for the next process to read.
			settled: world => {
				if (world.recorded?.word !== "restart") world.fail("I3", `recorded ${world.recorded?.word}`);
				if (world.files.get(INTENT_PATH)?.text !== "stop\n") world.fail("I3", "the later word was consumed");
			},
		});
		expect(result.violations).toEqual([]);
		expect(result.schedules).toBeGreaterThan(100);
	});

	it("recovers the word a reader took before it died, oldest copies and all", () => {
		const world = new World();
		world.publish("restart");
		const first = new Reader("died-taking");
		// Up to and including the rename: the word is in a copy nobody has recorded.
		first.step(world);
		first.step(world);
		expect(world.files.has(INTENT_PATH)).toBe(false);
		expect(world.copies()).toEqual([first.claimedPath]);
		world.publish("stop");
		const second = new Reader("died-after-taking");
		second.step(world);
		second.step(world);
		expect(world.copies()).toEqual([first.claimedPath, second.claimedPath]);
		expect(world.recorded).toBeUndefined();

		const third = new Reader("recovery");
		third.runToEnd(world);
		// The sender's latest word wins; the word it replaced is not resurrected.
		expect(third.answer).toBe("stop");
		expect(world.copies()).toEqual([]);
		expect(world.files.has(INTENT_PATH)).toBe(false);
		expect(world.violations).toEqual([]);
	});

	it("takes the file once, records the word, and deletes only its own copy", () => {
		const world = new World();
		world.publish("restart");
		const reader = new Reader("plain");
		const effects: ExitContextClaimEffect[] = [];
		while (!reader.done) {
			effects.push(reader.pending!);
			reader.step(world);
		}
		expect(effects.map(effect => effect.kind)).toEqual([
			"recorded",
			"take",
			"list",
			"read",
			"record",
			"remove",
			"recorded",
		]);
		expect(reader.answer).toBe("restart");
		expect([...world.files.keys()]).toEqual([]);
		expect(world.violations).toEqual([]);
	});
});
