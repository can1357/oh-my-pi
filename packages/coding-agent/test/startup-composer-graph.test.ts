import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("startup composer prepaint graph", () => {
	it("stays isolated from settings, catalog, session runtime, and LSP modules", async () => {
		const pkgRoot = path.resolve(import.meta.dir, "..");
		const probe = `await import(${JSON.stringify(path.join(pkgRoot, "src/modes/startup-composer.ts"))});
			const reg = typeof Loader !== "undefined" && Loader.registry ? [...Loader.registry.keys()] : Object.keys(require.cache);
			console.log(JSON.stringify(reg));`;
		const proc = Bun.spawn([process.execPath, "-e", probe], { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code, err).toBe(0);
		const modules: string[] = JSON.parse(out.trim().split("\n").at(-1)!);
		expect(modules.length).toBeGreaterThan(50); // sanity: registry actually enumerated
		// Positive controls — the scene really is on this graph.
		expect(modules.some(m => m.includes("modes/components/welcome"))).toBe(true);
		expect(modules.some(m => m.includes("session/session-listing"))).toBe(true);
		// Isolation contract.
		const forbidden = [
			/config\/settings/,
			/pi-catalog/,
			/provider-models/,
			/session\/agent-session/,
			/session\/session-manager/,
			/src\/lsp\//,
			/image-persist/,
			/internal-url/,
			/modes\/interactive-mode/,
		];
		const violations = modules.filter(m => forbidden.some(re => re.test(m)));
		expect(violations).toEqual([]);
	});
});
