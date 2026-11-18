/** The command line a shell process is started with. */
import { describe, expect, it } from "bun:test";
import { parseShellProcessArgs, shellProcessArgs } from "../src/exec/shell-process-protocol";

describe("shell process arguments", () => {
	it("round-trip a spec whose command looks like the worker's own flags", () => {
		const spec = {
			command: "--source x; echo '--' --cwd y",
			source: "/tmp/seed with space.sh",
			cwd: "local://work dir",
		};

		expect(parseShellProcessArgs(shellProcessArgs(spec))).toEqual(spec);
		expect(parseShellProcessArgs(shellProcessArgs({ command: "" }))).toEqual({ command: "" });
		expect(shellProcessArgs(spec).at(-1)).toBe(spec.command);
	});

	it("reject a command line that is not a spec", () => {
		expect(parseShellProcessArgs([])).toBeUndefined();
		expect(parseShellProcessArgs(["echo", "hi"])).toBeUndefined();
		expect(parseShellProcessArgs(["--", "echo", "hi"])).toBeUndefined();
		expect(parseShellProcessArgs(["--source", "--", "echo hi"])).toBeUndefined();
		expect(parseShellProcessArgs(["--paths", "{}", "--", "echo hi"])).toBeUndefined();
	});
});
