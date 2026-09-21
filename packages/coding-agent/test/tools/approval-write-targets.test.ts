import { describe, expect, it } from "bun:test";
import { toolCallCwd, toolFileEffects } from "@oh-my-pi/pi-coding-agent/tools/approval-write-targets";

/** Every relative path in this file resolves against it; grant keys are absolute. */
const REPO = "/repo";

describe("toolFileEffects", () => {
	it("reads a write call's single target", () => {
		expect(toolFileEffects("write", { path: "src/a.ts", content: "export {};" }, REPO)).toEqual({
			writes: [`${REPO}/src/a.ts`],
			removes: false,
		});
		expect(toolFileEffects("write", { path: `${REPO}/src/a.ts`, content: "" }, "/elsewhere")).toEqual({
			writes: [`${REPO}/src/a.ts`],
			removes: false,
		});
		// Nothing to pin down: no argument names a file.
		expect(toolFileEffects("write", { content: "export {};" }, REPO)).toEqual({ writes: [], removes: false });
		expect(toolFileEffects("write", "not an object", REPO)).toBeUndefined();
	});

	it("reads an edit call's target in replace and patch shapes", () => {
		expect(toolFileEffects("edit", { path: "src/a.ts", old_string: "a", new_string: "b" }, REPO)).toEqual({
			writes: [`${REPO}/src/a.ts`],
			removes: false,
		});
		// The batch `replace` shape carries an `edits` array with no operation:
		// every entry rewrites the one path in place.
		expect(
			toolFileEffects("edit", { path: "src/a.ts", edits: [{ old_string: "a", new_string: "b" }] }, REPO),
		).toEqual({ writes: [`${REPO}/src/a.ts`], removes: false });
	});

	it("reports a patch delete or move as a removal, and never as a write of the path it takes away", () => {
		// A grant says "this session may write this file"; a delete asks for a
		// different effect, so the file must not read as a write target.
		expect(toolFileEffects("edit", { path: "src/a.ts", edits: [{ op: "delete" }] }, REPO)).toEqual({
			writes: [],
			removes: true,
		});
		// A move writes its destination and takes the source away.
		expect(
			toolFileEffects(
				"edit",
				{ path: "src/a.ts", edits: [{ op: "update", diff: "@@" }, { rename: "src/b.ts" }] },
				REPO,
			),
		).toEqual({ writes: [`${REPO}/src/b.ts`], removes: true });
		// `op: "create"` ignores its `rename` at execute time, so it moves nothing.
		expect(
			toolFileEffects("edit", { path: "src/a.ts", edits: [{ op: "create", rename: "src/b.ts", diff: "x" }] }, REPO),
		).toEqual({ writes: [`${REPO}/src/a.ts`], removes: false });
	});

	it("reads every file a hashline patch writes, and flags the ones it takes away", () => {
		const input = ["[src/a.ts#A1B2]", "PUT 1.=1:", "+x", "[src/b.ts#C3D4]", "MV src/c.ts"].join("\n");

		// One `edit` call can write several files; a grant for one of them must not
		// stand in for the rest, so all of them are reported. `src/b.ts` is moved
		// away, so only its destination is written.
		expect(toolFileEffects("edit", { input }, REPO)).toEqual({
			writes: [`${REPO}/src/a.ts`, `${REPO}/src/c.ts`],
			removes: true,
		});

		const removal = ["[src/a.ts#A1B2]", "REM"].join("\n");
		expect(toolFileEffects("edit", { input: removal }, REPO)).toEqual({ writes: [], removes: true });
	});

	it("reads every file an apply-patch envelope writes, and flags the ones it takes away", () => {
		const input = [
			"*** Begin Patch",
			"*** Add File: src/new.ts",
			"+export {};",
			"*** Update File: src/old.ts",
			"*** Move to: src/moved.ts",
			"@@",
			"-a",
			"+b",
			"*** Delete File: src/gone.ts",
			"*** End Patch",
		].join("\n");

		expect(toolFileEffects("edit", { input }, REPO)).toEqual({
			writes: [`${REPO}/src/new.ts`, `${REPO}/src/moved.ts`],
			removes: true,
		});
	});

	it("reports nothing for input neither patch dialect accepts", () => {
		// A call that cannot apply grants nothing, and a parse failure must not
		// escape into the approval gate.
		const empty = { writes: [], removes: false };
		expect(toolFileEffects("edit", { input: "just prose" }, REPO)).toEqual(empty);
		expect(toolFileEffects("edit", { input: "*** Begin Patch\n*** End Patch" }, REPO)).toEqual(empty);
		expect(toolFileEffects("edit", { input: "" }, REPO)).toEqual(empty);
	});

	it("reports nothing for a tool whose effects only a model can read out of it", () => {
		// `bash` writes through a shell command, so its file grants come from the
		// classifier's cited targets instead — structural coverage would let
		// `rm -rf src/a.ts` ride a grant to write `src/a.ts`.
		expect(toolFileEffects("bash", { command: "echo hi > src/a.ts" }, REPO)).toBeUndefined();
		expect(toolFileEffects("task", { prompt: "write src/a.ts" }, REPO)).toBeUndefined();
	});

	it("drops targets no grant key can pin down, and repeats", () => {
		// Handler-owned schemes are not files, and a glob names a set that would
		// widen with the filesystem.
		expect(toolFileEffects("write", { path: "local://notes.md", content: "" }, REPO)).toEqual({
			writes: [],
			removes: false,
		});
		expect(toolFileEffects("write", { path: "src/*.ts", content: "" }, REPO)).toEqual({
			writes: [],
			removes: false,
		});
		expect(toolFileEffects("edit", { path: "src/a.ts", edits: [{ rename: "./src/a.ts" }] }, REPO)).toEqual({
			writes: [`${REPO}/src/a.ts`],
			removes: true,
		});
	});
});

describe("toolCallCwd", () => {
	it("follows a bash call's own cwd and falls back to the session's", () => {
		// `bash` may run anywhere, so a relative target of its command resolves
		// against the directory that call actually uses.
		expect(toolCallCwd("bash", { command: "ls", cwd: "packages/tui" }, REPO)).toBe(`${REPO}/packages/tui`);
		expect(toolCallCwd("bash", { command: "ls", cwd: "/tmp/build" }, REPO)).toBe("/tmp/build");
		expect(toolCallCwd("bash", { command: "ls" }, REPO)).toBe(REPO);
		expect(toolCallCwd("bash", { command: "ls", cwd: "" }, REPO)).toBe(REPO);
		// A value that is no directory this session can pin down leaves the session
		// cwd in place rather than producing a grant key nothing will match.
		expect(toolCallCwd("bash", { command: "ls", cwd: "local://sandbox" }, REPO)).toBe(REPO);
	});

	it("ignores a cwd argument on any other tool", () => {
		// Only `bash` has a `cwd` argument; for the file tools the session's own
		// directory is the one their paths resolve against.
		expect(toolCallCwd("write", { path: "a.ts", content: "", cwd: "/tmp" }, REPO)).toBe(REPO);
		expect(toolCallCwd("edit", { path: "a.ts" }, REPO)).toBe(REPO);
	});
});
