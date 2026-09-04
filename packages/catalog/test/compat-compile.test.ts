import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { compileCompatRules, renderAuthIds } from "../scripts/compat-compiler";
import { compileAuth } from "../scripts/compat-compiler/compile-auth";
import { compileBehavior } from "../scripts/compat-compiler/compile-behavior";
import { compileCascade } from "../scripts/compat-compiler/compile-cascade";
import { compileTaxonomy } from "../scripts/compat-compiler/compile-taxonomy";
import committed from "../src/compat/rules.json";

const AUTH_IDS_PATH = path.join(import.meta.dir, "../src/compat/auth-ids.ts");

const RULES_DIR = path.join(import.meta.dir, "../src/compat/rules");

function taxonomySources(text: string) {
	return [
		{ file: "taxonomy/_collapse.kdl", text: 'collapse { thinking-suffix "-thinking" }' },
		{ file: "taxonomy/test.kdl", text },
	];
}

describe("compat compiler grammar", () => {
	test("unknown axis directive is rejected with file:line", () => {
		expect(() =>
			compileCascade([{ file: "classes/test.kdl", text: 'class "openai" {\n\tnot-an-axis #true\n}' }]),
		).toThrow(/classes\/test\.kdl:2.*unknown directive `not-an-axis`/);
	});

	test("malformed scalar shape is rejected", () => {
		expect(() =>
			compileCascade([{ file: "classes/test.kdl", text: 'class "openai" {\n\tsupports-store #true #false\n}' }]),
		).toThrow(/malformed value/);
	});

	test("enum-valued axis rejects out-of-vocabulary strings", () => {
		expect(() =>
			compileCascade([{ file: "classes/test.kdl", text: 'class "openai" {\n\tthinking-format "sideways"\n}' }]),
		).toThrow(/rejects value `sideways`/);
	});
	test("camelCase object-payload keys are rejected; kebab-case compiles to resolved keys", () => {
		expect(() =>
			compileCascade([
				{
					file: "providers/test.kdl",
					text: 'provider "opencode-go" {\n\twhen-thinking {\n\t\treasoningContentField "reasoning_content"\n\t}\n}',
				},
			]),
		).toThrow(/providers\/test\.kdl:3.*`reasoningContentField` must be kebab-case/);

		const compiled = compileCascade([
			{
				file: "providers/test.kdl",
				text: [
					'provider "opencode-go" {',
					"\twhen-thinking {",
					// Axis spelling maps through AXES (directive != mechanical camel)...
					"\t\ttemplate-reasoning-effort #true",
					// ...non-axis names convert mechanically...
					'\t\treasoning-content-field "reasoning_content"',
					// ...and extra-body subtrees keep literal wire keys.
					"\t\textra-body {",
					"\t\t\tenable_thinking #true",
					"\t\t}",
					"\t}",
					"}",
				].join("\n"),
			},
		]);
		expect(compiled.rules[0]?.wire?.whenThinking).toEqual({
			qwenTemplateReasoningEffort: true,
			reasoningContentField: "reasoning_content",
			extraBody: { enable_thinking: true },
		});
	});

	test("exclude-models rejects a duplicate provider property", () => {
		expect(() =>
			compileBehavior({
				file: "runtime/behavior.kdl",
				text: 'behavior {\n\texclude-models provider="a" provider="b" substring="tts"\n}',
			}),
		).toThrow(/malformed value/);
	});

	test("duplicate axis in one block is rejected", () => {
		expect(() =>
			compileCascade([
				{
					file: "classes/test.kdl",
					text: 'class "openai" {\n\tsupports-store #true\n\tsupports-store #false\n}',
				},
			]),
		).toThrow(/assigned twice/);
	});

	test("misplaced selector nesting is rejected", () => {
		// `on` is only allowed under a root class, never under provider.
		expect(() =>
			compileCascade([
				{
					file: "providers/test.kdl",
					text: 'provider "openai" {\n\ton "azure" {\n\t\tsupports-store #true\n\t}\n}',
				},
			]),
		).toThrow(/unexpected node `on`/);
	});

	test("duplicate class names across taxonomy sources are rejected", () => {
		expect(() =>
			compileTaxonomy([
				...taxonomySources('class "dup" { bounded "a" }'),
				{ file: "taxonomy/other.kdl", text: 'class "dup" { bounded "b" }' },
			]),
		).toThrow(/duplicate class/);
	});

	test("duplicate override (provider, model) pairs are rejected", () => {
		const override = 'override id="%ID%" model="opaque" class="dup" rationale="r" provenance="p"';
		expect(() =>
			compileTaxonomy(
				taxonomySources(
					`class "dup" { bounded "dup"\n${override.replace("%ID%", "one")}\n${override.replace("%ID%", "two")} }`,
				),
			),
		).toThrow(/duplicate override pair/);
	});

	test("missing collapse definition is rejected", () => {
		expect(() => compileTaxonomy([{ file: "taxonomy/test.kdl", text: 'class "solo" { bounded "solo" }' }])).toThrow(
			/collapse/,
		);
	});

	test("revision constraint operands must parse", () => {
		expect(() =>
			compileCascade([
				{
					file: "classes/test.kdl",
					text: 'class "openai" {\n\trevision ">=banana" {\n\t\tsupports-store #true\n\t}\n}',
				},
			]),
		).toThrow(/malformed value/);
	});
});

describe("auth grammar", () => {
	const order = (...ids: string[]) => ({
		file: "auth/_order.kdl",
		text: `login-order ${ids.map(id => JSON.stringify(id)).join(" ")}`,
	});

	test("oauth-code login without a refresh declaration is rejected", () => {
		expect(() =>
			compileAuth([
				{
					file: "auth/x.kdl",
					text: 'auth "x" {\n\tname "X"\n\tlogin "oauth-code" {\n\t\tauthorize-url "https://a"\n\t\tcallback port=1\n\t\ttoken url="https://t"\n\t}\n}',
				},
				order("x"),
			]),
		).toThrow(/auth\/x\.kdl:1.*no `refresh`/);
	});

	test("unknown login kind and unknown auth directive are rejected with file:line", () => {
		expect(() =>
			compileAuth([{ file: "auth/x.kdl", text: 'auth "x" {\n\tname "X"\n\tlogin "magic" {\n\t}\n}' }, order()]),
		).toThrow(/auth\/x\.kdl:3.*`login`/);
		expect(() => compileAuth([{ file: "auth/x.kdl", text: 'auth "x" {\n\tname "X"\n\tcolour "red"\n}' }])).toThrow(
			/auth\/x\.kdl:3.*unexpected node `colour`/,
		);
	});

	test("loginable providers must appear in login-order; non-login providers sort after it", () => {
		const login = 'auth "b" {\n\tname "B"\n\tlogin "api-key" {\n\t\tprompt "Paste"\n\t}\n}';
		const plain = 'auth "a" {\n\tname "A"\n}';
		expect(() =>
			compileAuth([{ file: "auth/b.kdl", text: login }, { file: "auth/a.kdl", text: plain }, order()]),
		).toThrow(/loginable provider "b" is missing from login-order/);
		const compiled = compileAuth([
			{ file: "auth/a.kdl", text: plain },
			{ file: "auth/b.kdl", text: login },
			order("b"),
		]);
		expect(compiled.providers.map(p => p.id)).toEqual(["b", "a"]);
		expect(renderAuthIds(compiled)).toContain('export type LoginProviderId = "b";');
		expect(renderAuthIds(compiled)).toContain('export type AuthProviderId = "a" | "b";');
	});

	test("oauth-code derives callback-port and paste-code; refresh inherits the login token request", () => {
		const compiled = compileAuth([
			{
				file: "auth/x.kdl",
				text: [
					'auth "x" {',
					'\tname "X"',
					'\tlogin "oauth-code" {',
					'\t\tclient-id "aWQ=" encoding="base64" env="X_CLIENT_ID"',
					'\t\tauthorize-url "https://a"',
					"\t\tpkce #true",
					'\t\tcallback port=4242 path="/cb" native-scheme=#true',
					'\t\ttoken url="https://t" body="json" { params { state "{state}" } }',
					'\t\tcredential { expires "seconds" from="created_at" skew-ms=0 }',
					"\t}",
					'\trefresh { require "projectId" }',
					"}",
				].join("\n"),
			},
			order("x"),
		]);
		const [x] = compiled.providers;
		expect(x.callbackPort).toBe(4242);
		expect(x.pasteCode).toBe(true);
		expect(x.login).toMatchObject({
			kind: "oauth-code",
			clientId: { value: "aWQ=", encoding: "base64", env: ["X_CLIENT_ID"] },
			callback: { nativeScheme: true },
			credential: { expires: { mode: "seconds", path: "expires_in", fromPath: "created_at", skewMs: 0 } },
		});
		expect(x.refresh).toMatchObject({
			kind: "request",
			require: ["projectId"],
			token: { url: { value: "https://t" }, body: "json", standard: true, params: {} },
			credential: { expires: { fromPath: "created_at" } },
		});
	});
});

describe("committed rules.json", () => {
	test("matches a fresh compile of rules/ (run `bun run gen:compat` after editing KDL)", async () => {
		const fresh = await compileCompatRules(RULES_DIR);
		expect(fresh).toEqual(committed);
		expect(await Bun.file(AUTH_IDS_PATH).text()).toBe(renderAuthIds(fresh.auth));
	});
});
