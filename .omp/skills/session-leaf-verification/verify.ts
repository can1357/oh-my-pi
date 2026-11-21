#!/usr/bin/env bun
/**
 * Exhaustive check of the session-tree leaf contract at a bounded depth.
 *
 * Every sequence of SessionManager operations up to DEPTH long is replayed from
 * scratch against the real class (no model of it), and after each step:
 *
 *   P0 off-branch write  appendMessageToBranch() leaves the active leaf alone
 *   P1 replay agreement  resolveSessionLeafId(entries) === getLeafId()
 *   P2 no dangling leaf  getLeafId() is null or names a stored entry
 *   P3 branch is a chain getBranch() walks parent links back to the root
 *   P4 persistence       close + reopen reproduces the same leaf and branch
 *
 * Usage: bun .omp/skills/session-leaf-verification/verify.ts [depth]
 *        VERIFY_SEQUENCE='append user|append answer' bun .../verify.ts   (replay one sequence)
 * `packages/coding-agent/test/session/session-leaf-exhaustive.test.ts` runs
 * `explore(3)` in CI so this harness stays in sync with the session modules.
 * Exit code 0 = every sequence held; 1 = a counterexample, printed as the
 * shortest operation sequence that broke the property.
 *
 * The property is the one a user feels when resuming: the branch they left on
 * must be the branch that comes back, and a late result from another branch
 * must never steal it. `packages/coding-agent/test/session/off-branch-leaf-replay.test.ts`
 * pins the one case that was reported; this explores the interleavings around it.
 */
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveSessionLeafId } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
const answer = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "anthropic-messages" as const,
	provider: "anthropic" as const,
	model: "claude-sonnet-4-20250514",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 0,
});

interface State {
	manager: SessionManager;
	root: string;
	firstUser?: string;
	firstAnswer?: string;
}

/** One step a caller can take. Reopen swaps the live manager for a loaded one. */
interface Step {
	name: string;
	run: (state: State) => Promise<void> | void;
}

const OFF_BRANCH_STEP = "off-branch result on first answer";
const OFF_BRANCH_USAGE_STEP = "off-branch usage on first answer";

const STEPS: Step[] = [
	{
		name: "append user",
		run: state => {
			const id = state.manager.appendMessage(user(`prompt ${state.manager.getEntries().length}`));
			state.firstUser ??= id;
		},
	},
	{
		name: "append answer",
		run: state => {
			const id = state.manager.appendMessage(answer(`answer ${state.manager.getEntries().length}`));
			state.firstAnswer ??= id;
		},
	},
	{
		name: "branch to first user",
		run: state => {
			if (state.firstUser) state.manager.branch(state.firstUser);
		},
	},
	{
		name: OFF_BRANCH_STEP,
		run: state => {
			if (state.firstAnswer) state.manager.appendMessageToBranch(user("late result"), state.firstAnswer);
		},
	},
	{
		name: OFF_BRANCH_USAGE_STEP,
		run: state => {
			if (!state.firstAnswer) return;
			state.manager.appendModelUsage(
				{
					purpose: "verify",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					usage: answer("").usage,
					stopReason: "stop",
				},
				{ sessionId: state.manager.getSessionId(), parentId: state.firstAnswer },
			);
		},
	},
	{
		name: "reopen",
		run: async state => {
			const file = state.manager.getSessionFile();
			if (!file) throw new Error("session file missing");
			// A session that holds no assistant message yet is deliberately not
			// written to disk. Force the file so the round trip is exercised.
			await state.manager.ensureOnDisk();
			await state.manager.close();
			state.manager = await SessionManager.open(file);
		},
	},
];

function checklist(state: State, sequence: string[], options: { replayAgreement: boolean }): string | undefined {
	const manager = state.manager;
	const entries = manager.getEntries();
	const leaf = manager.getLeafId();
	const prefix = sequence.join(" -> ");

	// P2
	if (leaf !== null && !entries.some(entry => entry.id === leaf)) {
		return `${prefix}\nP2 dangling leaf: ${leaf} is not a stored entry (${entries.length} entries)`;
	}

	// P1 is only asserted after an append. A bare branch() moves the leaf in
	// memory and is documented as transient; the journal has not changed, so
	// replay is expected to report the old tip until the next entry lands.
	if (options.replayAgreement) {
		const replayed = resolveSessionLeafId(entries);
		if (replayed !== leaf) {
			const dump = entries
				.map(entry => `${entry.id}/${entry.type}/${entry.parentId ?? "-"}/${entry.activeLeafId ?? ""}`)
				.join(" ");
			return `${prefix}\nP1 replay disagreement: live leaf ${leaf}, replayed leaf ${replayed} from ${entries.length} entries\nentries: ${dump}\nbranch: ${manager
				.getBranch()
				.map(entry => entry.id)
				.join(",")}`;
		}
	}

	// P3
	const branch = manager.getBranch();
	for (let index = 1; index < branch.length; index++) {
		if (branch[index].parentId !== branch[index - 1].id) {
			return `${prefix}\nP3 branch breaks at ${branch[index].id}: parent ${branch[index].parentId}, previous ${branch[index - 1].id}`;
		}
	}
	if (branch.length > 0 && branch.at(-1)!.id !== leaf) {
		return `${prefix}\nP3 branch ends at ${branch.at(-1)!.id}, leaf is ${leaf}`;
	}

	return undefined;
}

const STEP_NAMES = STEPS.map(step => step.name);

function stepNamed(name: string): Step {
	const step = STEPS.find(candidate => candidate.name === name);
	if (!step) throw new Error(`unknown step "${name}"; valid steps: ${STEP_NAMES.join(", ")}`);
	return step;
}

async function runSequence(names: string[], trace: boolean): Promise<string | undefined> {
	const dir = TempDir.createSync("@omp-leaf-verify-");
	const root = dir.path();
	const state: State = {
		manager: SessionManager.create(root, path.join(root, "sessions")),
		root,
	};
	let managerOpen = true;
	try {
		const applied: string[] = [];
		let lastStepAppended = false;
		for (const name of names) {
			const step = stepNamed(name);
			const before = state.manager.getEntries().length;
			const leafBefore = state.manager.getLeafId();
			await step.run(state);
			lastStepAppended = state.manager.getEntries().length > before;
			const offBranch =
				name === OFF_BRANCH_STEP || (name === OFF_BRANCH_USAGE_STEP && leafBefore !== state.firstAnswer);
			if (offBranch && state.manager.getEntries().length > before) {
				const leafAfter = state.manager.getLeafId();
				if (leafAfter !== leafBefore) {
					return `${[...applied, name].join(" -> ")}\nP0 off-branch append moved the leaf: ${leafBefore} -> ${leafAfter}`;
				}
			}
			applied.push(name);
			if (trace) {
				const dump = state.manager
					.getEntries()
					.map(entry => `${entry.id}/${entry.type}/${entry.parentId ?? "-"}`)
					.join(" ");
				console.log(`after ${name}: leaf=${state.manager.getLeafId()} entries=[${dump}]`);
			}
			const failure = checklist(state, applied, { replayAgreement: lastStepAppended });
			if (failure) return failure;
		}
		// P4: the file must replay to the same state the live manager reports.
		// Skipped when the sequence ends on transient navigation (a bare branch)
		// or on a reopen that already came from disk. A session without an
		// assistant message is not written until asked, so there is nothing on
		// disk to compare against in that case.
		if (!lastStepAppended) return undefined;
		const file = state.manager.getSessionFile();
		if (!file || !(await Bun.file(file).exists())) return undefined;
		const liveLeaf = state.manager.getLeafId();
		const liveBranch = state.manager.getBranch().map(entry => entry.type);
		managerOpen = false;
		await state.manager.close();
		const reopened = await SessionManager.open(file);
		try {
			const replayedLeaf = reopened.getLeafId();
			const replayedBranch = reopened.getBranch().map(entry => entry.type);
			if (replayedLeaf !== liveLeaf) {
				return `${names.join(" -> ")}\nP4 reopen leaf drift: live ${liveLeaf}, reopened ${replayedLeaf}`;
			}
			if (replayedBranch.join(",") !== liveBranch.join(",")) {
				return `${names.join(" -> ")}\nP4 reopen branch drift: live ${liveBranch.join(",")}, reopened ${replayedBranch.join(",")}`;
			}
			const replayFailure = checklist({ ...state, manager: reopened }, names, { replayAgreement: true });
			if (replayFailure) return replayFailure;
		} finally {
			await reopened.close();
		}
		return undefined;
	} finally {
		// Every exit releases the session lease and writer before the dir goes.
		if (managerOpen) await state.manager.close();
		await dir.remove();
	}
}

/** Breadth-first over every sequence up to `depth`, or a single replay of `only`. */
export async function explore(
	depth: number,
	only?: string[],
): Promise<{ explored: number; failure?: string; depth?: number }> {
	if (only) for (const name of only) stepNamed(name);
	let explored = 0;
	const queue: string[][] = only ? [only] : [[]];
	while (queue.length > 0) {
		const sequence = queue.shift()!;
		if (sequence.length > 0) {
			explored++;
			const failure = await runSequence(sequence, only !== undefined);
			if (failure) return { explored, failure, depth: sequence.length };
		}
		// A replay runs exactly the printed sequence, never its extensions.
		if (!only && sequence.length < depth) {
			for (const step of STEPS) queue.push([...sequence, step.name]);
		}
	}
	return { explored };
}

if (import.meta.main) {
	const depth = Number.parseInt(process.argv[2] ?? "4", 10);
	if (!Number.isInteger(depth) || depth < 1) throw new Error(`invalid depth: ${process.argv[2]}`);
	const result = await explore(depth, process.env.VERIFY_SEQUENCE?.split("|"));
	if (result.failure) {
		console.error(result.failure);
		console.error(`\nFAIL after ${result.explored} sequences (depth ${result.depth})`);
		process.exit(1);
	}
	console.log(`OK: ${result.explored} operation sequences up to depth ${depth} held P0-P4`);
}
