/**
 * JSON-Schema-Test-Suite conformance for drafts 2020-12 and 7 (core and
 * optional, without format assertions), through every engine path: the plan
 * interpreter, the generated validator, and error explanations.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { generate } from "../src/jsonschema/codegen";
import { Sink, validate } from "../src/jsonschema/interpret";
import { Planner } from "../src/jsonschema/plan";
import { Registry } from "../src/jsonschema/resolve";

interface SuiteGroup {
	description: string;
	schema: unknown;
	tests: { description: string; data: unknown; valid: boolean }[];
}

const fixtures = path.join(import.meta.dir, "fixtures");
const suite = path.join(fixtures, "json-schema-test-suite");

/**
 * Optional features the engine leaves out: `format-assertion` needs built-in
 * format checks (only caller-supplied `formats` assert), and draft 7 content
 * assertions (`contentMediaType`/`contentEncoding`) are annotations here.
 */
const UNSUPPORTED = new Set(["draft2020-12/optional/format-assertion.json", "draft7/optional/content.json"]);

async function loadSchemas(): Promise<Record<string, unknown>> {
	const schemas: Record<string, unknown> = {};
	const remotes = path.join(suite, "remotes");
	for (const file of new Bun.Glob("**/*.json").scanSync({ cwd: remotes })) {
		schemas[`http://localhost:1234/${file.replaceAll("\\", "/")}`] = await Bun.file(path.join(remotes, file)).json();
	}
	const meta = path.join(fixtures, "meta-schemas");
	schemas["http://json-schema.org/draft-07/schema"] = await Bun.file(path.join(meta, "draft-07-schema.json")).json();
	schemas["https://json-schema.org/draft/2020-12/schema"] = await Bun.file(
		path.join(meta, "draft2020-12-schema.json"),
	).json();
	for (const vocabulary of [
		"core",
		"applicator",
		"unevaluated",
		"validation",
		"meta-data",
		"format-annotation",
		"content",
	]) {
		schemas[`https://json-schema.org/draft/2020-12/meta/${vocabulary}`] = await Bun.file(
			path.join(meta, `draft2020-12-meta-${vocabulary}.json`),
		).json();
	}
	return schemas;
}

const schemas = await loadSchemas();

for (const [directory, draft] of [
	["draft2020-12", "2020-12"],
	["draft7", "7"],
] as const) {
	const files = [...new Bun.Glob("**/*.json").scanSync({ cwd: path.join(suite, "tests", directory) })].sort();
	for (const file of files) {
		const name = `${directory}/${file.replaceAll("\\", "/")}`;
		if (UNSUPPORTED.has(name)) continue;
		const groups: SuiteGroup[] = await Bun.file(path.join(suite, "tests", directory, file)).json();
		describe(name, () => {
			for (const group of groups) {
				it(group.description, () => {
					const plan = new Planner(new Registry(draft, structuredClone(schemas)), undefined).root(
						structuredClone(group.schema),
					);
					const generated = generate(plan);
					if (generated === undefined) throw new Error("code generation unavailable");
					for (const test of group.tests) {
						const sink = new Sink();
						const outcome = {
							test: test.description,
							interpreted: validate(plan, test.data),
							generated: generated(test.data),
							explained: (validate(plan, test.data, sink), sink.issues.length === 0),
						};
						expect(outcome).toEqual({
							test: test.description,
							interpreted: test.valid,
							generated: test.valid,
							explained: test.valid,
						});
					}
				});
			}
		});
	}
}
