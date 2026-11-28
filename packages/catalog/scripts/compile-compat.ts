/**
 * `bun run gen:compat` — compiles `src/compat/rules/` into
 * `src/compat/rules.json`, the committed compiled form the runtime engine
 * imports. Mirrors the models.json discipline: deterministic output,
 * regenerate + commit together with rule changes.
 */
import * as path from "node:path";
import { compileCompatRules } from "./compat-compiler";

const rulesDir = path.join(import.meta.dir, "../src/compat/rules");
const outPath = path.join(import.meta.dir, "../src/compat/rules.json");

const compiled = await compileCompatRules(rulesDir);
await Bun.write(outPath, JSON.stringify(compiled));
console.log(
	`wrote ${path.relative(process.cwd(), outPath)} (${compiled.cascade.rules.length} rules, ${compiled.taxonomy.classes.length} classes, ${Object.keys(compiled.providers).length} catalog providers, ${compiled.auth.providers.length} auth providers, ${compiled.files.length} files)`,
);
