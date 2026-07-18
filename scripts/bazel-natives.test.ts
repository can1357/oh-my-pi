import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { parseBuildBindingsArgs } from "../packages/natives/scripts/build-bindings-options";
import { createHostBuildCommand } from "./bazel-natives";

describe("host native build", () => {
	test("forwards an isolated dest directory to build-bindings", () => {
		const script = path.join("packages", "natives", "scripts", "build-bindings.ts");
		const destDir = path.join("tmp", "native-out");
		expect(createHostBuildCommand(script, destDir)).toEqual([process.execPath, script, "--dest", destDir]);
	});

	test("parses --dest for packaging builds", () => {
		expect(parseBuildBindingsArgs(["--dest", "out"])).toEqual({ dest: "out" });
		expect(parseBuildBindingsArgs([])).toEqual({ dest: null });
	});
});
