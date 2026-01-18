import { describe, expect, it } from "bun:test";
import { createPythonTool } from "./tools/python";

const pythonPath = Bun.which("python") ?? Bun.which("python3");
const hasKernelDeps = (() => {
	if (!pythonPath) return false;
	const result = Bun.spawnSync(
		[
			pythonPath,
			"-c",
			"import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('kernel_gateway') and importlib.util.find_spec('ipykernel') else 1)",
		],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	return result.exitCode === 0;
})();

const shouldRun = Boolean(pythonPath) && hasKernelDeps;

describe.skipIf(!shouldRun)("PYTHON_PRELUDE integration", () => {
	it("exposes prelude helpers via python tool", async () => {
		const helpers = [
			"pwd",
			"cd",
			"env",
			"read",
			"write",
			"append",
			"mkdir",
			"rm",
			"mv",
			"cp",
			"ls",
			"find",
			"grep",
			"rgrep",
			"head",
			"tail",
			"replace",
			"run",
			"bash",
		];

		const session = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: {
				getImageAutoResize: () => true,
				getLspFormatOnWrite: () => false,
				getLspDiagnosticsOnWrite: () => false,
				getLspDiagnosticsOnEdit: () => false,
				getEditFuzzyMatch: () => true,
				getGitToolEnabled: () => true,
				getBashInterceptorEnabled: () => true,
				getBashInterceptorSimpleLsEnabled: () => true,
				getBashInterceptorRules: () => [],
				getPythonToolMode: () => "ipy-only" as const,
				getPythonKernelMode: () => "per-call" as const,
			},
		};

		const tool = createPythonTool(session);
		const code = `
helpers = ${JSON.stringify(helpers)}
missing = [name for name in helpers if name not in globals() or not callable(globals()[name])]
print("HELPERS_OK=" + ("1" if not missing else "0"))
if missing:
    print("MISSING=" + ",".join(missing))
`;

		const result = await tool.execute("tool-call-1", { code });
		const output = result.content.find((item) => item.type === "text")?.text ?? "";
		expect(output).toContain("HELPERS_OK=1");
	});
});
