/** Isolated apply succeeded; parent must re-run acceptance on this tree. */
export const MERGED_UNVERIFIED_MARKER = "MERGED — child yield is not evidence; re-run acceptance on this tree.";

export function annotateUnverifiedMergeSummary(mergeSummary: string, latch: boolean): string {
	if (!latch) return mergeSummary;
	if (mergeSummary.includes(MERGED_UNVERIFIED_MARKER)) return mergeSummary;
	const markerBlock = `\n${MERGED_UNVERIFIED_MARKER}`;
	return mergeSummary.length > 0 ? `${mergeSummary}${markerBlock}` : markerBlock;
}

export function isolatedApplyShouldLatch(args: {
	isolated: boolean;
	applyChanges: boolean;
	hadAnyChanges: boolean;
	exitCode: number;
}): boolean {
	// Key on `hadAnyChanges`, not `changesApplied`: a no-op merge ("No changes
	// to apply.") leaves the repo clean but applied nothing, so there is no
	// unverified child work for the parent to re-accept.
	return args.isolated && args.applyChanges && args.hadAnyChanges === true && args.exitCode === 0;
}

const TAUTOLOGICAL_BASH_COMMANDS = new Set([
	"pwd",
	"ls",
	"echo",
	"true",
	"date",
	"whoami",
	"hostname",
	"uname",
	"id",
	"printenv",
	"env",
	":",
]);

/** `ls` / `pwd` / `echo ok` are not parent acceptance of merged work. */
export function isTautologicalParentVerifyCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) return true;
	const segments = trimmed
		.split(/(?:&&|\|\||;|\n)+/)
		.map(segment => segment.trim())
		.filter(segment => segment.length > 0 && !segment.startsWith("#"));
	if (segments.length === 0) return true;
	return segments.every(segment => {
		const tokens = segment.replace(/^sudo\s+/, "").split(/\s+/);
		const invoked = tokens[0] ?? "";
		const base = invoked.split("/").pop() ?? invoked;
		return TAUTOLOGICAL_BASH_COMMANDS.has(base);
	});
}

/**
 * Pending unverified isolated merges. Each `mark()` adds one; a matching
 * parent verify decrements one. One bash cannot clear two overlapping merges.
 *
 * Generation increments on each `mark()` so a verification tool that started
 * before a merge can finish afterward without clearing a latch it never saw.
 */
export class UnverifiedMergeLatch {
	#pending = 0;
	#generation = 0;

	mark(): void {
		this.#generation++;
		this.#pending++;
	}

	clear(): void {
		this.#pending = 0;
	}

	/** Decrements one pending merge when the verifier started at the current generation. */
	clearIfGeneration(generationAtStart: number): void {
		if (this.#pending === 0) return;
		if (generationAtStart > 0 && generationAtStart === this.#generation) {
			this.#pending--;
		}
	}

	get latched(): boolean {
		return this.#pending > 0;
	}

	get generation(): number {
		return this.#generation;
	}
}
