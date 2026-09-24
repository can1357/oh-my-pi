import { spyOn } from "bun:test";
import * as parser from "@babel/parser";
import { __rewriteLegacyExtensionSourceForTests } from "../../src/extensibility/plugins/legacy-pi-compat";

const parseSpy = spyOn(parser, "parse");
try {
	const source = 'import value from "./dependency.js";\n';
	// Real loads tag relative imports per process; `--tag=<n>` varies it between runs.
	const tag = process.argv.find(arg => arg.startsWith("--tag="))?.slice("--tag=".length) ?? "7";
	const rewritten = await __rewriteLegacyExtensionSourceForTests(source, "/tmp/extension.ts", tag);
	if (process.argv.includes("--expect-cache-hit") && parseSpy.mock.calls.length !== 0) {
		throw new Error("Warm extension analysis reparsed the source");
	}
	process.stdout.write(rewritten);
} finally {
	parseSpy.mockRestore();
}
