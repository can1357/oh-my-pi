import { describe, expect, it } from "bun:test";

// Import from the zero-dep classify module — plugin-cli.ts transitively loads native addons.
import { classifyInstallTarget } from "@oh-my-pi/pi-coding-agent/cli/classify-install-target";

const KNOWN = new Set(["my-marketplace"]);

describe("classifyInstallTarget", () => {
	it("classifies plugin@marketplace as marketplace when marketplace is registered", () => {
		const result = classifyInstallTarget("hello@my-marketplace", KNOWN);
		expect(result).toEqual({ type: "marketplace", name: "hello", marketplace: "my-marketplace" });
	});

	it("classifies scoped @scope/pkg as npm (rule 1: starts with @)", () => {
		const result = classifyInstallTarget("@scope/pkg", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "@scope/pkg" });
	});

	it("classifies @scope/pkg@1.0.0 as npm (starts with @, rule 1 wins)", () => {
		const result = classifyInstallTarget("@scope/pkg@1.0.0", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "@scope/pkg@1.0.0" });
	});

	it("classifies bare name with no @ as npm", () => {
		const result = classifyInstallTarget("bare-name", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "bare-name" });
	});

	it("classifies pkg@version as npm when version is not a known marketplace", () => {
		const result = classifyInstallTarget("pkg@1.2.3", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "pkg@1.2.3" });
	});

	it("classifies pkg@marketplace as npm when marketplace is not registered", () => {
		const result = classifyInstallTarget("hello@my-marketplace", new Set());
		expect(result).toEqual({ type: "npm", spec: "hello@my-marketplace" });
	});

	it("scoped @scope/pkg@marketplace is still npm — rule 1 wins", () => {
		// Even though this starts with @, the rule only triggers when spec.startsWith("@")
		// but @scope/pkg@my-marketplace DOES start with @ so rule 1 applies -> npm.
		// This confirms rule 1 is absolute for scoped packages.
		const result = classifyInstallTarget("@scope/pkg@my-marketplace", KNOWN);
		expect(result).toEqual({ type: "npm", spec: "@scope/pkg@my-marketplace" });
	});

	it("splits on last @ for non-scoped multi-@ spec", () => {
		// e.g. "some-pkg@my-marketplace" where my-marketplace is known
		const result = classifyInstallTarget("some-pkg@my-marketplace", KNOWN);
		expect(result).toEqual({ type: "marketplace", name: "some-pkg", marketplace: "my-marketplace" });
	});

	describe("local paths take precedence over npm classification", () => {
		const cases: Array<[string, string]> = [
			[".", "bare cwd"],
			["..", "bare parent"],
			["~", "bare home"],
			["./pkg", "cwd-relative"],
			["../pkg", "parent-relative"],
			[".\\pkg", "cwd-relative (windows)"],
			["..\\pkg", "parent-relative (windows)"],
			["~/pkg", "tilde-prefixed (posix)"],
			["~\\pkg", "tilde-prefixed (windows)"],
			["/abs/path", "posix absolute"],
			["C:\\abs\\path", "windows absolute (backslash)"],
			["C:/abs/path", "windows absolute (forward slash)"],
			["\\\\server\\share", "windows UNC"],
		];
		for (const [spec, label] of cases) {
			it(`classifies ${label} (${JSON.stringify(spec)}) as local`, () => {
				expect(classifyInstallTarget(spec, KNOWN)).toEqual({ type: "local", path: spec });
			});
		}

		it("does not misclassify package names that merely contain dots", () => {
			expect(classifyInstallTarget("my.plugin", KNOWN)).toEqual({ type: "npm", spec: "my.plugin" });
		});

		it("does not misclassify dist-tags or version specifiers as local", () => {
			expect(classifyInstallTarget("pkg@1.2.3", KNOWN)).toEqual({ type: "npm", spec: "pkg@1.2.3" });
		});
	});
});
