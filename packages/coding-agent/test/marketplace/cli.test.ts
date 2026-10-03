import { describe, expect, it, spyOn } from "bun:test";

import { classifyInstallTarget, handleMarketplaceInstall } from "@oh-my-pi/pi-coding-agent/cli/classify-install-target";

const KNOWN = new Set(["my-marketplace"]);

describe("classifyInstallTarget", () => {
	it("classifies plugin@marketplace as marketplace when marketplace is registered", () => {
		const result = classifyInstallTarget("hello@my-marketplace", KNOWN);
		expect(result).toEqual({ type: "marketplace", name: "hello", marketplace: "my-marketplace" });
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
	});
});

it("marketplace dry-run validates preconditions and emits a preview without invoking installPlugin", async () => {
	const manager = {
		validateInstallPlugin: async () => undefined,
		installPlugin: async () => undefined,
	};
	const validationSpy = spyOn(manager, "validateInstallPlugin");
	const installSpy = spyOn(manager, "installPlugin");
	const previews: unknown[] = [];
	const handled = await handleMarketplaceInstall(
		manager,
		{
			type: "marketplace",
			name: "hello",
			marketplace: "my-marketplace",
		},
		{ dryRun: true, force: true, scope: "project" },
		preview => previews.push(preview),
	);

	expect(handled).toBe(true);
	expect(validationSpy).toHaveBeenCalledWith("hello", "my-marketplace", { force: true, scope: "project" });
	expect(installSpy).not.toHaveBeenCalled();
	expect(previews).toEqual([
		{
			dryRun: true,
			action: "install",
			plugin: "hello",
			marketplace: "my-marketplace",
		},
	]);
});
