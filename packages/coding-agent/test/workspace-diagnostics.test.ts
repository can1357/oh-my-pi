import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	combineDiagnosticsOutputs,
	combineProjectDescriptions,
	detectProjectTypes,
	interpretEmptyDiagnosticsResult,
} from "../src/lsp/workspace-diagnostics";

const command = ["npx", "tsc", "--noEmit"];

const roots: string[] = [];

/** Build a throwaway workspace root containing exactly the given marker files. */
function makeRoot(...markers: string[]): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-workspace-diagnostics-"));
	roots.push(root);
	for (const marker of markers) {
		fs.writeFileSync(path.join(root, marker), "");
	}
	return root;
}

afterAll(() => {
	for (const root of roots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("interpretEmptyDiagnosticsResult", () => {
	test("reports a silent non-zero exit as an unverified workspace", () => {
		expect(interpretEmptyDiagnosticsResult(17, null, command)).toBe(
			"Failed to run npx tsc --noEmit: the checker exited with code 17 without reporting anything, so the workspace was not verified",
		);
	});

	test("reports a signal when the checker was killed silently", () => {
		expect(interpretEmptyDiagnosticsResult(137, "SIGKILL", command)).toBe(
			"Failed to run npx tsc --noEmit: the checker was killed by SIGKILL without reporting anything, so the workspace was not verified",
		);
	});

	test("preserves the clean-workspace result for a successful silent checker", () => {
		expect(interpretEmptyDiagnosticsResult(0, null, command)).toBe("No issues found");
	});
});

describe("detectProjectTypes", () => {
	// #8385: detection returned on the first matching marker, so a root holding
	// both `Cargo.toml` and `tsconfig.json` only ever ran cargo and reported the
	// workspace verified while TypeScript was never checked at all.
	test("detects every language in a polyglot root instead of only the first", async () => {
		const detected = await detectProjectTypes(makeRoot("Cargo.toml", "tsconfig.json"));

		const descriptions = detected.map(entry => entry.description);
		expect(detected.map(entry => entry.type)).toEqual(["rust", "typescript"]);
		expect(descriptions).toEqual(["Rust (cargo check)", "TypeScript (tsc --noEmit)"]);
		for (const entry of detected) {
			expect(entry.command?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("keeps priority order across all four supported toolchains", async () => {
		const markers = ["Cargo.toml", "tsconfig.json", "go.mod", "pyproject.toml"];
		const detected = await detectProjectTypes(makeRoot(...markers));

		expect(detected.map(entry => entry.type)).toEqual(["rust", "typescript", "go", "python"]);
	});

	test("returns a single entry for a single-language root", async () => {
		const detected = await detectProjectTypes(makeRoot("tsconfig.json"));

		expect(detected).toHaveLength(1);
		expect(detected[0]?.type).toBe("typescript");
		expect(detected[0]?.command).toEqual(["npx", "tsc", "--noEmit"]);
	});

	test("treats go.work and go.mod as one toolchain, preferring the workspace", async () => {
		const detected = await detectProjectTypes(makeRoot("go.work", "go.mod"));

		expect(detected).toHaveLength(1);
		expect(detected[0]?.type).toBe("go");
		expect(detected[0]?.description).toBe("Go workspace (go build)");
	});

	test("treats pyproject.toml and pyrightconfig.json as one toolchain", async () => {
		const detected = await detectProjectTypes(makeRoot("pyproject.toml", "pyrightconfig.json"));

		expect(detected).toHaveLength(1);
		expect(detected[0]?.type).toBe("python");
	});

	test("reports a single unknown entry when no marker is present", async () => {
		const detected = await detectProjectTypes(makeRoot());

		expect(detected).toHaveLength(1);
		expect(detected[0]?.type).toBe("unknown");
		expect(detected[0]?.command).toBeUndefined();
	});
});

describe("combineProjectDescriptions", () => {
	test("names every checker that ran", () => {
		const combined = combineProjectDescriptions([
			{ type: "rust", description: "Rust (cargo check)" },
			{ type: "typescript", description: "TypeScript (tsc --noEmit)" },
		]);

		expect(combined).toBe("Rust (cargo check) + TypeScript (tsc --noEmit)");
	});

	test("leaves a single description untouched", () => {
		expect(combineProjectDescriptions([{ type: "go", description: "Go (go build)" }])).toBe("Go (go build)");
	});
});

describe("combineDiagnosticsOutputs", () => {
	test("keeps a single language's output bare", () => {
		const rust = { description: "Rust (cargo check)", output: "No issues found" };

		expect(combineDiagnosticsOutputs([rust])).toBe("No issues found");
	});

	test("labels each language so a failure is attributable to its checker", () => {
		const rust = { description: "Rust (cargo check)", output: "No issues found" };
		const ts = { description: "TypeScript (tsc --noEmit)", output: "src/a.ts(1,1): error TS2304" };
		const expected =
			"=== Rust (cargo check) ===\nNo issues found\n\n=== TypeScript (tsc --noEmit) ===\nsrc/a.ts(1,1): error TS2304";

		expect(combineDiagnosticsOutputs([rust, ts])).toBe(expected);
	});
});
