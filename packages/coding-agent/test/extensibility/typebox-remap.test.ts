import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Type as TypeBoxShimType } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-typebox";
import {
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// The remap installs a Bun.plugin onResolve hook plus an explicit
// rewrite branch inside `rewriteBareImportsForLegacyExtension` that
// redirects bare `@sinclair/typebox` specifiers to the omptype-backed
// compatibility surface. Extensions should keep working unchanged without
// `@sinclair/typebox` ever needing to be installed.
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
				"export const schema = Type.Unsafe({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			probe: typeof TypeBoxShimType;
			schema: Record<string, unknown>;
		};

		expect(loaded.probe).toBe(TypeBoxShimType);
		// `Type.Unsafe` is now a first-class omptype schema (so `Type.Optional`/
		// `Type.Object` can compose it), so a top-level Unsafe tool param takes the
		// omptype wire path and is closed like every other tool param. Compare the
		// JSON-serialized wire — internal memoization stamps are non-serialized.
		const wire = toolWireSchema({ name: "fixture", description: "", parameters: loaded.schema });
		expect(JSON.parse(JSON.stringify(wire))).toEqual({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
			additionalProperties: false,
		});
	});

	it("preserves raw JSON Schema properties passed directly to Type.Object", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { Type } from "typebox";',
				"export const schema = Type.Object({ cfg: { type: 'string', pattern: '^ok' }, label: Type.Optional(Type.String()) });",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			schema: Record<string, unknown> & { safeParse(input: unknown): { success: boolean } };
		};

		expect(loaded.schema.safeParse({ cfg: "okay" }).success).toBe(true);
		expect(loaded.schema.safeParse({ cfg: "bad" }).success).toBe(false);
		expect(loaded.schema.safeParse({ cfg: { type: "string" } }).success).toBe(false);
		const wire = toolWireSchema({ name: "fixture", description: "", parameters: loaded.schema });
		expect(JSON.parse(JSON.stringify(wire))).toEqual({
			type: "object",
			properties: {
				cfg: { type: "string", pattern: "^ok" },
				label: { type: "string" },
			},
			required: ["cfg"],
			additionalProperties: false,
		});
	});

	it("redirects minified bare typebox imports without whitespace around from", async () => {
		const entry = await writeFixtureExtension(
			'import{Type}from"typebox";export const schema=Type.Object({name:Type.String()});',
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			schema: { safeParse: (input: unknown) => { success: boolean } };
		};
		expect(loaded.schema.safeParse({ name: "ok" }).success).toBe(true);
		expect(loaded.schema.safeParse({}).success).toBe(false);
	});
});
