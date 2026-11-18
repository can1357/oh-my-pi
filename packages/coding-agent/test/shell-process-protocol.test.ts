/**
 * The command line a shell process is started with: what it runs, and the host
 * locations behind the URL paths it may open.
 */
import { describe, expect, it } from "bun:test";
import { parseShellProcessArgs, shellProcessArgs } from "../src/exec/shell-process-protocol";

describe("shell process arguments", () => {
	it("round-trip a spec whose command looks like the worker's own flags", () => {
		const spec = {
			command: "--paths {}; echo '--' --source x",
			paths: {
				local: "/sessions/a b/local",
				localReadOnly: true as const,
				artifacts: "/sessions/a b",
				skills: { review: "/skills/review/SKILL.md", "plugin/lint": "/plugins/p/lint/SKILL.md" },
				attachments: { "attachment://1": "/blobs/ab cd.png" },
			},
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
		expect(parseShellProcessArgs(["--paths", "--", "echo hi"])).toBeUndefined();
		expect(parseShellProcessArgs(["--paths", "not json", "--", "echo hi"])).toBeUndefined();
		expect(parseShellProcessArgs(["--paths", '{"skills":{"a":1}}', "--", "echo hi"])).toBeUndefined();
		expect(parseShellProcessArgs(["--paths", '{"memory":"/x"}', "--", "echo hi"])).toBeUndefined();
	});
});
