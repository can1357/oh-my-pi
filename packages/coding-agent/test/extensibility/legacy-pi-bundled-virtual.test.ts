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

	// Compiled binaries fire no resolve hook for the `<source>/jsx-runtime` import Bun injects
	// for a `@jsxImportSource` pragma, so the pragma itself must name the bundled module (#20840).
	it("points a host @jsxImportSource pragma at the bundled runtime", async () => {
		using dir = TempDir.createSync("@omp-bundled-jsx-extension-");
		const entry = dir.join("extension.tsx");
		const rewrittenEntry = dir.join("rewritten.tsx");
		await Bun.write(
			entry,
			[
				"/** @jsxImportSource @oh-my-pi/pi-tui */",
				'export const pragmaText = "@jsxImportSource @oh-my-pi/pi-tui";',
				'export const node = () => <text spans={[{ t: "A" }]} />;',
			].join("\n"),
		);
		const jsxRuntimePath = import.meta.resolve("../../../tui/src/jsx-runtime.ts");
		const jsxDevRuntimePath = import.meta.resolve("../../../tui/src/jsx-dev-runtime.ts");
		const compatPath = import.meta.resolve("../../src/extensibility/plugins/legacy-pi-compat.ts");
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`
import * as jsxRuntime from ${JSON.stringify(jsxRuntimePath)};
import * as jsxDevRuntime from ${JSON.stringify(jsxDevRuntimePath)};
import { __rewriteLegacyExtensionSourceForTests, installLegacyPiSpecifierShim } from ${JSON.stringify(compatPath)};
const servedKeys = [];
const serve = (key, module) => async () => { servedKeys.push(key); return module; };
Bun.plugin({
	name: "bundled-jsx-fixture",
	setup(build) {
		build.module("omp-legacy-pi-modules", () => ({
			loader: "object",
			exports: {
				BUNDLED_PI_MODULE_LOADERS: {
					"@oh-my-pi/pi-tui": async () => { throw new Error("pi-tui root evaluated"); },
					"@oh-my-pi/pi-tui/jsx-runtime": serve("@oh-my-pi/pi-tui/jsx-runtime", jsxRuntime),
					"@oh-my-pi/pi-tui/jsx-dev-runtime": serve("@oh-my-pi/pi-tui/jsx-dev-runtime", jsxDevRuntime),
				},
			},
		}));
	},
});
installLegacyPiSpecifierShim();
const rewritten = await __rewriteLegacyExtensionSourceForTests(await Bun.file(${JSON.stringify(entry)}).text(), ${JSON.stringify(entry)});
await Bun.write(${JSON.stringify(rewrittenEntry)}, rewritten);
const extension = await import(${JSON.stringify(rewrittenEntry)});
console.log(JSON.stringify({
	pragma: rewritten.split("\\n")[0],
	pragmaText: extension.pragmaText,
	kind: extension.node().kind,
	servedKeys,
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
		const observed = JSON.parse(result.stdout);
		expect(observed).toMatchObject({
			pragma: "/** @jsxImportSource omp-legacy-pi-bundled:@oh-my-pi/pi-tui */",
			pragmaText: "@jsxImportSource @oh-my-pi/pi-tui",
			kind: "text",
		});
		expect(observed.servedKeys).toHaveLength(1);
		expect(observed.servedKeys[0]).toMatch(/^@oh-my-pi\/pi-tui\/jsx(-dev)?-runtime$/);
	});
});
