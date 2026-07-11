import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { Type as TypeBoxShimType } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/typebox";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

// The remap installs a Bun.plugin onResolve hook plus an explicit
// rewrite branch inside `rewriteBareImportsForLegacyExtension` that
// redirects bare `@sinclair/typebox` specifiers to the in-repo Zod-backed
// shim. Extensions that authored against TypeBox should keep working
// unchanged without `@sinclair/typebox` ever needing to be installed.
installLegacyPiSpecifierShim();

const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function writeFixtureExtension(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-typebox-remap-"));
	tempRoots.push(dir);
	const entry = path.join(dir, "index.ts");
	await fs.writeFile(entry, source, "utf8");
	return entry;
}

describe("legacy-pi TypeBox remap", () => {
	it("redirects bare @sinclair/typebox imports inside legacy extensions to the in-repo shim", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { Type } from "@sinclair/typebox";',
				"export const probe = Type;",
				"export const objectSchema = Type.Object({ name: Type.String() }, { additionalProperties: false });",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			probe: typeof TypeBoxShimType;
			objectSchema: { safeParse: (input: unknown) => { success: boolean } };
		};

		expect(loaded.probe).toBe(TypeBoxShimType);
		expect(loaded.objectSchema.safeParse({ name: "ok" }).success).toBe(true);
		expect(loaded.objectSchema.safeParse({ name: "ok", extra: 1 }).success).toBe(false);
	});

	it("redirects bare typebox imports inside legacy extensions to the in-repo shim", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { Type } from "typebox";',
				"export const probe = Type;",
				"export const enumSchema = Type.Enum(['upstream', 'downstream']);",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			probe: typeof TypeBoxShimType;
			enumSchema: { safeParse: (input: unknown) => { success: boolean } };
		};

		expect(loaded.probe).toBe(TypeBoxShimType);
		expect(loaded.enumSchema.safeParse("upstream").success).toBe(true);
		expect(loaded.enumSchema.safeParse("sideways").success).toBe(false);
	});
});
