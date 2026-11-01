/**
 * `bun run gen:config-schema`: regenerates `src/config/omp-config.schema.json`, the JSON Schema for
 * `config.yml` derived from the settings registry. The file is committed and attached to every
 * GitHub release; `test/config/settings-json-schema.test.ts` fails when it is stale.
 */
import * as path from "node:path";
import { renderSettingsJsonSchema } from "../src/config/settings-json-schema";

const SCHEMA_PATH = path.resolve(import.meta.dir, "../src/config/omp-config.schema.json");

/** Generated file path → contents. */
export function generateConfigSchemaArtifacts(): Map<string, string> {
	return new Map([[SCHEMA_PATH, renderSettingsJsonSchema()]]);
}

if (import.meta.main) {
	for (const [file, contents] of generateConfigSchemaArtifacts()) {
		await Bun.write(file, contents);
		console.log(`wrote ${path.relative(process.cwd(), file)}`);
	}
}
