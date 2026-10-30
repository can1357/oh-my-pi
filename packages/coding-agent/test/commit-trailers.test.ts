import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withCommitTrailers } from "@oh-my-pi/pi-coding-agent/utils/commit-trailers";
import { $ } from "bun";

const TRAILER = "Omp-Session: 01a13dca-e979-7264-af32-f654ef57a6f5";
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "T",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "T",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

/** What `git interpret-trailers` makes of the same message and trailer. */
async function gitAppend(message: string): Promise<string> {
	const git = $`git -c trailer.Omp-Session.ifexists=addIfDifferent interpret-trailers --trailer ${TRAILER} < ${new Response(message)}`;
	return await git.env(GIT_ENV).text();
}

/** What `git log --format=%(trailers:…)` reads back from a commit of `message`. */
async function trailerOfCommit(message: string): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-commit-trailers-"));
	try {
		const file = path.join(dir, "message.txt");
		await Bun.write(file, message);
		await $`git init -q -b m ${dir}`.env(GIT_ENV).quiet();
		await $`git -C ${dir} commit -q --allow-empty --cleanup=verbatim -F ${file}`.env(GIT_ENV).quiet();
		const format = "--format=%(trailers:key=Omp-Session,valueonly)";
		return (await $`git -C ${dir} log -1 ${format}`.env(GIT_ENV).text()).trim();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Where the trailer landed: its line, and whether a blank line opened a new
 * paragraph for it. Comparing this and not the whole text is deliberate — git
 * also rewrites the message's own lines (`Bug:12345` becomes `Bug: 12345`, and
 * a bare URL becomes `https: //…`), which this module never does.
 */
function placement(out: string): { line: number; ofLines: number; blankBefore: boolean } {
	const lines = out.trimEnd().split("\n");
	const line = lines.lastIndexOf(TRAILER);
	return { line, ofLines: lines.length, blankBefore: line > 0 && lines[line - 1].trim() === "" };
}

// Each shape decides a different branch of git's trailer-block rule, so our
// placement has to agree with git's on all of them: a commit whose trailers git
// can no longer read is the failure this module exists to prevent.
const SHAPES: Record<string, string> = {
	"prose body, no trailers": "subject\n\nbody text\n",
	"one trailer": 'speedup\n\nResult: {"status":"keep"}',
	"separator with no space": "subject\n\nBug:12345\nChange-Id: I1234567890\n",
	"bare URL, a trailer to git": "subject\n\nRefs: #1\nhttps://github.com/can1357/oh-my-pi/issues/1\n",
	"indented line above the trailer": "subject\n\n    some indented log output\nRefs: #1\n",
	"continuation under the trailer": "subject\n\nAcked-by: A\n  more of A\n",
	"two blank lines": "subject\n\n\nChange-Id: I12\n",
	"prose plus a git-generated trailer": "subject\n\nFixes #12\nSigned-off-by: A <a@b>",
	"prose plus a cherry-pick line": "subject\n\nsome prose\n(cherry picked from commit deadbeef)\n",
	"prose that only looks like a trailer": "subject\n\nFixes rocq-prover/rocq#22632\n",
	"three prose lines and one trailer": "subject\n\nline one\nline two\nline three\nRefs: #1\n",
	"empty trailer value": "subject\n\nEmpty:\n",
	"the trailer is already there": `subject\n\n${TRAILER}\n`,
	"a key with a space, rescued by a git-generated trailer":
		"subject\n\nBenchmark entrypoint: bash a.sh\nSigned-off-by: A <a@b>",
	"one prose line above four trailers": "subject\n\nprose\nA: b\nC: d\nE: f\nG: h\n",
	"git-generated trailer under four prose lines": "subject\n\nprose\nx\ny\nz\nSigned-off-by: A <a@b>\n",
	"git-generated trailer under prose with continuations":
		"subject\n\nprose\n one\n two\n three\n four\n five\n six\nSigned-off-by: A <a@b>\n",
	"git-generated trailer under three prose lines": "subject\n\nprose\nx\ny\nSigned-off-by: A <a@b>\n",
	"a subject that looks like a trailer, never a trailer to git": "style: formatted code\n",
	"a dotted key, which git counts as prose": "subject\n\nfile.txt: changed\n",
	"whitespace before the separator": "subject\n\nKey : v\n",
	"the trailer with a continuation, a different value to git": `subject\n\n${TRAILER}\n  more\n`,
};

// git's two code paths disagree on these: `interpret-trailers` appends inside
// the message's last paragraph, and `git log --format=%(trailers:…)` then reads
// back no trailer at all. The message must win over the placement, so these
// shapes are pinned by what a real commit parses to, not by git's own output.
const UNREADABLE_AFTER_GIT: Record<string, string> = {
	"a bare subject": "subject",
	"a key with a space in it, which git counts as prose":
		"autoresearch: harness setup\n\nBenchmark entrypoint: bash autoresearch.sh\nGoal: speed",
};

describe("withCommitTrailers", () => {
	it("leaves the message alone when nothing is configured", () => {
		expect(withCommitTrailers("fix: x\n", "")).toBe("fix: x\n");
	});

	it("reads PI_COMMIT_TRAILERS when the caller passes nothing", () => {
		const previous = process.env.PI_COMMIT_TRAILERS;
		process.env.PI_COMMIT_TRAILERS = TRAILER;
		try {
			expect(withCommitTrailers("subject\n\nbody")).toBe(`subject\n\nbody\n\n${TRAILER}\n`);
		} finally {
			if (previous === undefined) delete process.env.PI_COMMIT_TRAILERS;
			else process.env.PI_COMMIT_TRAILERS = previous;
		}
	});

	it("ignores a configured line that is not a trailer", () => {
		expect(withCommitTrailers("subject\n\nbody\n", "not a trailer")).toBe("subject\n\nbody\n");
		expect(withCommitTrailers("subject\n\nbody\n", "Key value")).toBe("subject\n\nbody\n");
	});

	// The git-backed cases spawn git, so they get more than the 5 s default: on a
	// loaded machine a spawn alone can take seconds.
	it.each(Object.entries(SHAPES))(
		"puts the trailer where git puts it: %s",
		async (_name, message) => {
			const ours = withCommitTrailers(message, TRAILER);
			expect(placement(ours)).toEqual(placement(await gitAppend(message)));
			expect(ours.startsWith(message.trimEnd())).toBe(true);
		},
		30_000,
	);

	it.each(Object.entries(UNREADABLE_AFTER_GIT))(
		"keeps the trailer readable where git's own placement does not: %s",
		async (_name, message) => {
			expect(await trailerOfCommit(await gitAppend(message))).toBe("");
			expect(await trailerOfCommit(withCommitTrailers(message, TRAILER))).toBe(
				TRAILER.slice("Omp-Session: ".length),
			);
		},
		30_000,
	);

	it("adds every configured trailer, in order, and skips the ones already there", () => {
		expect(withCommitTrailers("subject\n\nbody", `${TRAILER}\nSigned-off-by: A <a@b>`)).toBe(
			`subject\n\nbody\n\n${TRAILER}\nSigned-off-by: A <a@b>\n`,
		);
		expect(withCommitTrailers(`subject\n\n${TRAILER}`, `${TRAILER}\nSigned-off-by: A <a@b>`)).toBe(
			`subject\n\n${TRAILER}\nSigned-off-by: A <a@b>\n`,
		);
	});

	it("leaves a message that already carries the trailer unchanged, so an amend never repeats it", () => {
		const message = `subject\n\n${TRAILER}\n`;
		expect(withCommitTrailers(message, TRAILER)).toBe(message);
	});

	it("finds the trailer in every spelling git parses to the same trailer", () => {
		const value = TRAILER.slice("Omp-Session: ".length);
		for (const line of [`Omp-Session:${value}`, `omp-session: ${value.toUpperCase()}`, `Omp-Session :  ${value} `]) {
			const message = `subject\n\n${line}\n`;
			expect(withCommitTrailers(message, TRAILER)).toBe(message);
		}
	});
});
