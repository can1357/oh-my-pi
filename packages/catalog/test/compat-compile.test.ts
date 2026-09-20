import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { compileCompatRules, renderAuthIds } from "../scripts/compat-compiler";
import { compileAuth } from "../scripts/compat-compiler/compile-auth";
import { compileBehavior } from "../scripts/compat-compiler/compile-behavior";
import { compileCascade } from "../scripts/compat-compiler/compile-cascade";
import { compileProviders } from "../scripts/compat-compiler/compile-providers";
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

	test("exclude-discovery-modes compiles exact provider mode exclusions", () => {
		const compiled = compileBehavior({
			file: "runtime/behavior.kdl",
			text: 'behavior {\n\texclude-discovery-modes "embedding" "moderation" provider="litellm"\n}',
		});
		expect(compiled.excludeDiscoveryModes).toEqual([{ provider: "litellm", modes: ["embedding", "moderation"] }]);
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

	test("identity override selectors are mutually exclusive", () => {
		const required = 'class="dup" rationale="r" provenance="p"';
		expect(() =>
			compileTaxonomy(
				taxonomySources(
					`class "dup" { bounded "dup"\noverride id="both" model="opaque" glob="opaque*" ${required} }`,
				),
			),
		).toThrow(/malformed value/);
		expect(() =>
			compileTaxonomy(taxonomySources(`class "dup" { bounded "dup"\noverride id="neither" ${required} }`)),
		).toThrow(/malformed value/);
	});

	test("glob override selectors compile case-insensitively and reject duplicate provider patterns", () => {
		const compiled = compileTaxonomy(
			taxonomySources(
				'class "dup" { bounded "dup"\noverride id="one" provider="host" glob="Opaque-27B*" class="dup" rationale="r" provenance="p" }',
			),
		);
		expect(compiled.classes[0]?.overrides[0]).toMatchObject({
			id: "one",
			provider: "host",
			glob: "opaque-27b*",
		});
		expect(() =>
			compileTaxonomy(
				taxonomySources(
					'class "dup" { bounded "dup"\noverride id="one" provider="host" glob="Opaque*" class="dup" rationale="r" provenance="p"\noverride id="two" provider="HOST" glob="opaque*" class="dup" rationale="r" provenance="p" }',
				),
			),
		).toThrow(/duplicate override glob/);
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

	test("provider-owned authentication APIs compile into auth policy", () => {
		const compiled = compileAuth([
			{
				file: "auth/x.kdl",
				text: 'auth "x" {\n\tname "X"\n\tnative-auth-api "bedrock-converse-stream" "openai-responses"\n}',
			},
			order(),
		]);
		expect(compiled.providers[0]?.nativeAuthApis).toEqual(["bedrock-converse-stream", "openai-responses"]);
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

describe("provider catalog grammar", () => {
	const row = [
		'\t\tmodel "m" name="M" {',
		"\t\t\treasoning #true",
		'\t\t\tinput "text"',
		"\t\t\tcost input=1 output=2 cache-read=0.1 cache-write=0",
		"\t\t\tlimits context=1000",
		"$AXES",
		"\t\t}",
	];
	const provider = (id: string, nodes: string[]) => `provider "${id}" {\n${nodes.join("\n")}\n}`;
	const seed = (header: string, axes = "") =>
		[`\tseed ${header} {`, ...row.map(line => (line === "$AXES" ? axes : line)), "\t}"].join("\n");
	const src = (text: string) => [{ file: "providers/p.kdl", text }];

	test("entry nodes compile alongside cascade rules; catalog membership requires default-model", () => {
		const compiled = compileProviders(
			src(
				provider("p", [
					'\tdefault-model "m"',
					'\tenv "P_KEY" "P_ALT"',
					"\tdynamic-models-authoritative #true",
					'\tdiscovery label="P" oauth-provider="p" allow-unauthenticated=#true { env "P_GEN" }',
					"\tsupports-store #false",
				]),
			),
		);
		expect(compiled.p).toEqual({
			id: "p",
			defaultModel: "m",
			envVars: ["P_KEY", "P_ALT"],
			dynamicModelsAuthoritative: true,
			discovery: { label: "P", oauthProvider: "p", allowUnauthenticated: true, envVars: ["P_GEN"] },
		});
		// The cascade sees only the axis; catalog nodes are not directives.
		const cascade = compileCascade(
			src(provider("p", ['\tdefault-model "m"', '\tenv "P_KEY"', "\tsupports-store #false"])),
		);
		expect(cascade.rules).toEqual([
			{ source: "providers/p.kdl:1", providers: ["p"], wire: { supportsStore: false } },
		]);
		// Wire-compat-only files (custom provider ids) are not catalog entries…
		expect(compileProviders(src(provider("llama.cpp", ["\tsupports-store #false"])))).toEqual({});
		// …but a stray catalog node without default-model is an error, not a silent drop.
		expect(() => compileProviders(src(provider("p", ['\tenv "P_KEY"'])))).toThrow(
			/providers\/p\.kdl:1.*has catalog nodes but no default-model/,
		);
	});

	test("runner seeds and per-kind APIs compile without entering the cascade", () => {
		const model = (id: string, name: string, api?: string) =>
			[
				`\t\tmodel "${id}" name="${name}"${api === undefined ? "" : ` api="${api}"`} {`,
				"\t\t\treasoning #false",
				'\t\t\tinput "text"',
				"\t\t\tcost input=0 output=0 cache-read=0 cache-write=0",
				"\t\t\tlimits",
				"\t\t}",
			].join("\n");
		const text = provider("p", [
			'\tdefault-model "local"',
			'\tkind-apis {\n\t\timage "openai-responses"\n\t\ttts "xai-tts"\n\t\tstt "openai-speech"\n\t}',
			[
				'\tseed api="local-inference" base-url="local://inference" {',
				model("local", "Local"),
				model("image", "Image", "openai-images"),
				model("speech", "Speech", "xai-tts"),
				"\t}",
			].join("\n"),
		]);
		const { p } = compileProviders(src(text));
		expect(p.kindApis).toEqual({
			image: "openai-responses",
			tts: "xai-tts",
			stt: "openai-speech",
		});
		expect(p.seed?.models.map(entry => [entry.id, entry.api])).toEqual([
			["local", "local-inference"],
			["image", "openai-images"],
			["speech", "xai-tts"],
		]);
		expect(compileCascade(src(text)).rules).toEqual([]);
	});

	test("kind-apis rejects duplicate, unsupported, malformed, and unknown API declarations", () => {
		const compileKindApis = (body: string) =>
			compileProviders(src(provider("p", ['\tdefault-model "m"', `\tkind-apis {\n${body}\n\t}`])));
		expect(() => compileKindApis('\t\timage "openai-images"\n\t\timage "openai-responses"')).toThrow(
			/directive `image` has a malformed value/,
		);
		expect(() => compileKindApis('\t\tvideo "openai-images"')).toThrow(/unexpected node `video` under `kind-apis`/);
		expect(() => compileKindApis('\t\timage "openai-images" "openai-responses"')).toThrow(
			/directive `image` has a malformed value/,
		);
		expect(() => compileKindApis('\t\timage "not-an-api"')).toThrow(/unknown api `not-an-api`/);
		expect(() =>
			compileProviders(
				src(
					provider("p", [
						'\tdefault-model "m"',
						'\tkind-apis {\n\t\timage "openai-images"\n\t}',
						'\tkind-apis {\n\t\ttts "xai-tts"\n\t}',
					]),
				),
			),
		).toThrow(/directive `kind-apis` has a malformed value/);
	});

	test("seed APIs reject values outside the known and runner API sets", () => {
		expect(() =>
			compileProviders(src(provider("p", ['\tdefault-model "m"', seed('api="not-an-api" base-url="https://x"')]))),
		).toThrow(/unknown api `not-an-api`/);
	});

	test("seed axis directives split into thinking/compat; catalog axes and foreign wire axes are rejected", () => {
		const { p } = compileProviders(
			src(
				provider("p", [
					'\tdefault-model "m"',
					seed(
						'api="openai-completions" base-url="https://x" bundle="fallback"',
						'\t\t\tthinking-mode "effort"\n\t\t\tthinking-efforts "low" "high"\n\t\t\tsupports-developer-role #false',
					),
				]),
			),
		);
		expect(p.seed?.bundle).toBe("fallback");
		expect(p.seed?.precedence).toBe("upstream");
		expect(p.seed?.models[0]).toMatchObject({
			id: "m",
			provider: "p",
			api: "openai-completions",
			baseUrl: "https://x",
			maxTokens: null,
			thinking: { mode: "effort", efforts: ["low", "high"] },
			compat: { supportsDeveloperRole: false },
		});
		const seeded = (header: string, axes: string) => src(provider("p", ['\tdefault-model "m"', seed(header, axes)]));
		expect(() =>
			compileProviders(seeded('api="openai-completions" base-url="https://x"', '\t\t\tedit-revision "x"')),
		).toThrow(/providers\/p\.kdl:9.*catalog axis `edit-revision` is rule-owned/);
		expect(() =>
			compileProviders(seeded('api="local-inference" base-url="local://inference"', '\t\t\tkind "tiny"')),
		).toThrow(/catalog axis `kind` is rule-owned/);
		expect(() =>
			compileProviders(seeded('api="openai-completions" base-url="https://x"', '\t\t\tweb-search "openrouter"')),
		).toThrow(/catalog axis `web-search` is rule-owned/);
		expect(() =>
			compileProviders(seeded('api="anthropic-messages" base-url="https://x"', "\t\t\tsupports-store #true")),
		).toThrow(/wire axis `supports-store` does not apply to api `anthropic-messages`/);
		expect(() =>
			compileProviders(seeded('api="openai-completions" base-url="https://x"', '\t\t\tthinking-efforts "low"')),
		).toThrow(/need both thinking-mode and thinking-efforts/);
		expect(() =>
			compileProviders(seeded('api="openai-completions" base-url="https://x" bundle="sometimes"', "")),
		).toThrow(/seed bundle must be one of/);
	});

	test("models-from copies rows under the inheriting provider; entries are keyed and sorted by id", () => {
		const compiled = compileProviders([
			{
				file: "providers/q.kdl",
				text: provider("q", ['\tdefault-model "m"', '\tseed { models-from "p" }']),
			},
			{
				file: "providers/p.kdl",
				text: provider("p", ['\tdefault-model "m"', seed('api="openai-completions" base-url="https://x"')]),
			},
		]);
		expect(Object.keys(compiled)).toEqual(["p", "q"]);
		expect(compiled.q.seed?.models).toEqual([{ ...compiled.p.seed!.models[0], provider: "q" }]);
		expect(() =>
			compileProviders([
				{ file: "providers/q.kdl", text: provider("q", ['\tdefault-model "m"', '\tseed { models-from "p" }']) },
			]),
		).toThrow(/models-from `p` must name a provider seed with its own model rows/);
	});
});

describe("committed rules.json", () => {
	test("matches a fresh compile of rules/ (run `bun run gen:compat` after editing KDL)", async () => {
		const fresh = await compileCompatRules(RULES_DIR);
		expect(fresh).toEqual(committed);
		expect(await Bun.file(AUTH_IDS_PATH).text()).toBe(renderAuthIds(fresh.auth));
	});
});
