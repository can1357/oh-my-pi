import { describe, expect, it } from "bun:test";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

describe("bundled extension modules", () => {
	it("serves the host's own module objects and native default/named exports", async () => {
		using dir = TempDir.createSync("@omp-bundled-extension-");
		const entry = dir.join("extension.ts");
		await Bun.write(
			entry,
			[
				'import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";',
				'import format, { double } from "@oh-my-pi/pi-utils/virtual-fixture";',
				"export { currentTheme };",
				"export function describe(value) { return format(double(value)); }",
			].join("\n"),
		);
		const runtimePath = import.meta.resolve("../../../tui/src/theme/runtime.ts");
		const compatPath = import.meta.resolve("../../src/extensibility/plugins/legacy-pi-compat.ts");
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`
import * as host from ${JSON.stringify(runtimePath)};
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from ${JSON.stringify(compatPath)};
Bun.plugin({
	name: "bundled-extension-fixture",
	setup(build) {
		build.module("omp-legacy-pi-modules", () => ({
			loader: "object",
			exports: {
				BUNDLED_PI_MODULE_LOADERS: {
					"@oh-my-pi/pi-tui/theme/runtime": async () => host,
					"@oh-my-pi/pi-utils/virtual-fixture": async () => ({
						default: value => "value=" + value,
						double: value => value * 2,
					}),
					"unused": async () => { throw new Error("unrelated host module evaluated"); },
				},
			},
		}));
	},
});
installLegacyPiSpecifierShim();
const extension = await loadLegacyPiModule(${JSON.stringify(entry)});
console.log(JSON.stringify({
	sharedTheme: extension.currentTheme === host.currentTheme,
	formatted: extension.describe(21),
}));
`,
			],
			{
				env: { ...Bun.env, PI_BUNDLED: "1", PI_TEST_RUNTIME: "1", PI_CODING_AGENT_DIR: dir.join("agent") },
				timeout: 15_000,
				allowNonZero: true,
			},
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ sharedTheme: true, formatted: "value=42" });
	});
});
