/**
 * `bun run gen:compat` — compiles `src/compat/rules/` into
 * `src/compat/rules.json`, the committed compiled form the runtime engine
 * imports. Mirrors the models.json discipline: deterministic output,
 * regenerate + commit together with rule changes.
 */
import * as path from "node:path";
import { compileCompatRules, renderAuthIds, renderProviderIds, serializeCompatRules } from "./compat-compiler";

const rulesDir = path.join(import.meta.dir, "../src/compat/rules");
const outPath = path.join(import.meta.dir, "../src/compat/rules.json");
const authIdsPath = path.join(import.meta.dir, "../src/compat/auth-ids.ts");
const providerIdsPath = path.join(import.meta.dir, "../src/compat/provider-ids.ts");

const compiled = await compileCompatRules(rulesDir);
const { json, index } = serializeCompatRules(compiled);
await Bun.write(outPath, json);
await Bun.write(path.join(path.dirname(outPath), "rules-index.json"), JSON.stringify(index));
await Bun.write(authIdsPath, renderAuthIds(compiled.auth));
await Bun.write(providerIdsPath, renderProviderIds(compiled.providers));
console.log(
	`wrote ${path.relative(process.cwd(), outPath)} (${compiled.cascade.rules.length} rules, ${compiled.taxonomy.classes.length} classes, ${Object.keys(compiled.providers).length} catalog providers, ${compiled.auth.providers.length} auth providers, ${compiled.files.length} files)`,
);
