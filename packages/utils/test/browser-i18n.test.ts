import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("browser asset language packs", () => {
	it("localizes explicit markers safely while leaving browser expressions and user text intact", () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-browser-language-"));
		const hostile = '</script><script>alert("pack")</script>\u2028';
		try {
			writeFileSync(
				join(directory, "ko.json"),
				JSON.stringify({
					"Label\u0004browser-assets": hostile,
					"Count: {0}\u0004browser-assets": "개수: {0}",
				}),
			);
			const modulePath = new URL("../src/browser-i18n.ts", import.meta.url).href;
			const html =
				'<html lang="en"><title data-omp-i18n>Label</title><input title="Label" data-omp-i18n-attrs="title"><p>Label</p><span data-omp-i18n>Missing</span></html>';
			const scriptSource =
				'const label = ompT("Label"); const count = ompT("Count: {0}", window.count); const user = "Label";';
			const script = `import {initializeI18n} from ${JSON.stringify(new URL("../src/i18n.ts", import.meta.url).href)};
await initializeI18n();
import {browserLanguagePackScript, localizeBrowserHtml, localizeBrowserScript, localizeBrowserManifest} from ${JSON.stringify(modulePath)};
console.log(JSON.stringify({pack: browserLanguagePackScript(), html: localizeBrowserHtml(${JSON.stringify(html)}), script: localizeBrowserScript(${JSON.stringify(scriptSource)}), manifest: JSON.parse(localizeBrowserManifest(${JSON.stringify(JSON.stringify({ description: "Label", action: { default_title: "Missing" } }))}))}));`;
			const run = (language: string) => {
				const child = Bun.spawnSync([process.execPath, "-e", script], {
					env: { ...process.env, OMP_LANG: language, OMP_LOCALE_DIR: directory, PI_COMPILED: undefined },
				});
				expect(child.exitCode, child.stderr.toString()).toBe(0);
				return JSON.parse(child.stdout.toString());
			};
			const korean = run("ko");
			expect(korean.html).toContain('<html lang="ko">');
			expect(korean.html).toContain("&lt;/script&gt;&lt;script&gt;alert(&quot;pack&quot;)&lt;/script&gt;");
			expect(korean.pack.match(/<\/script>/g)).toHaveLength(1);
			expect(korean.pack).toContain('"language":"ko"');
			expect(korean.pack).toContain("\\u003c/script>");
			expect(korean.html).toContain("<p>Label</p><span>Missing</span>");
			expect(korean.html).not.toContain("data-omp-i18n");
			expect(korean.script).not.toContain("</script>");
			expect(korean.script).toContain("\\u003c/script>");
			expect(korean.script).toContain('ompT("개수: {0}", window.count)');
			expect(korean.script).toContain('const user = "Label"');
			expect(korean.manifest).toEqual({ description: hostile, action: { default_title: "Missing" } });
			const english = run("en");
			expect(english.html).toContain('<html lang="en"><title>Label</title>');
			expect(english.script).toBe(scriptSource);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function browserSnapshot(options: { globalPack?: unknown; documentText?: string | null; noDocument?: boolean } = {}) {
	const modulePath = new URL("../src/i18n-browser.ts", import.meta.url).href;
	const script = `const options = ${JSON.stringify(options)};
let reads = 0;
let fetches = 0;
const errors = [];
console.error = (...values) => errors.push(values.join(" "));
globalThis.fetch = async () => { fetches++; throw new Error("UNEXPECTED_FETCH"); };
globalThis.__OMP_I18N__ = options.globalPack;
if (!options.noDocument) globalThis.document = {
	getElementById() {
		reads++;
		return Object.hasOwn(options, "documentText") ? {textContent: options.documentText} : null;
	},
	documentElement: {lang: "host"}
};
// Dynamic import is intentional: observe import-time DOM/fetch access before initialization.
const i18n = await import(${JSON.stringify(modulePath)});
const imported = [i18n.getLanguage(), i18n.t("Known"), reads, fetches, globalThis.document?.documentElement.lang];
await i18n.initializeI18n();
console.log(JSON.stringify({
	imported,
	language: i18n.getLanguage(),
	messages: i18n.getMessages(),
	translated: [i18n.t("Known"), i18n.t("Missing\\u0004unknown"), i18n.t("Count {0} then {1}", "one", "two")],
	documentLanguage: globalThis.document?.documentElement.lang,
	reads, fetches, errors
}));`;
	const child = Bun.spawnSync([process.execPath, "-e", script], {
		env: { ...process.env, OMP_LANG: "ko", OMP_LOCALE_DIR: "PRIVATE_UNUSED_BROWSER_PATH", PI_COMPILED: undefined },
	});
	expect(child.exitCode, child.stderr.toString()).toBe(0);
	expect(child.stderr.toString()).toBe("");
	return JSON.parse(child.stdout.toString());
}

describe("explicit browser language initialization", () => {
	it("defaults to English without import-time DOM access or hidden catalog fetches", () => {
		expect(browserSnapshot()).toEqual({
			imported: ["en", "Known", 0, 0, "host"],
			language: "en",
			messages: {},
			translated: ["Known", "Missing", "Count one then two"],
			documentLanguage: "en",
			reads: 1,
			fetches: 0,
			errors: [],
		});
		const worker = browserSnapshot({ noDocument: true });
		expect(worker.imported).toEqual(["en", "Known", 0, 0, null]);
		expect(worker.language).toBe("en");
		expect(worker.reads).toBe(0);
		expect(worker.fetches).toBe(0);
		expect(worker.errors).toEqual([]);
	});

	it("uses only explicitly selected Korean messages supplied by the host", () => {
		const messages = { Known: "알려진 문구", "Count {0} then {1}": "{1} 다음 {0}" };
		for (const language of ["ko", "ko-KR", "KO-KR"]) {
			const selected = browserSnapshot({ globalPack: { language, messages } });
			expect(selected.imported).toEqual(["en", "Known", 0, 0, "host"]);
			expect(selected.language).toBe("ko");
			expect(selected.documentLanguage).toBe("ko");
			expect(selected.messages).toEqual(messages);
			expect(selected.translated).toEqual(["알려진 문구", "Missing", "two 다음 one"]);
			expect(selected.fetches).toBe(0);
			expect(selected.errors).toEqual([]);
		}
		for (const language of [undefined, "", "en", "en-US", "fr", "ko_KR", "ko-KP"]) {
			const selected = browserSnapshot({ globalPack: { language, messages } });
			expect(selected.language).toBe("en");
			expect(selected.documentLanguage).toBe("en");
			expect(selected.messages).toEqual({});
			expect(selected.translated).toEqual(["Known", "Missing", "Count one then two"]);
			expect(selected.fetches).toBe(0);
			expect(selected.errors).toEqual([]);
		}
	}, 30_000);

	it("prefers server JSON over the global pack and updates the HTML language", () => {
		const selected = browserSnapshot({
			documentText: JSON.stringify({ language: "ko", messages: { Known: "서버 문구" } }),
			globalPack: { language: "ko", messages: { Known: "전역 문구" } },
		});
		expect(selected.language).toBe("ko");
		expect(selected.documentLanguage).toBe("ko");
		expect(selected.translated[0]).toBe("서버 문구");
		expect(selected.errors).toEqual([]);
		const english = browserSnapshot({
			documentText: '{"language":"en"}',
			globalPack: { language: "ko", messages: { Known: "전역 문구" } },
		});
		expect(english.documentLanguage).toBe("en");
		expect(english.translated[0]).toBe("Known");
	});

	it("falls back safely for malformed JSON, messages, and placeholders without revealing rejected data", () => {
		const invalidPacks = [
			null,
			[],
			"PRIVATE_PACK_VALUE",
			{ language: "ko" },
			{ language: "ko", messages: null },
			{ language: "ko", messages: [] },
			{ language: "ko", messages: { PRIVATE_PACK_VALUE: false } },
			{ language: "ko", messages: { PRIVATE_PACK_VALUE: "{1}" } },
			{ language: "ko", messages: { "Known {0}": "{999999999999999999999999}" } },
		];
		const invalidOptions = [
			...invalidPacks.map(globalPack => ({ globalPack })),
			{ documentText: "{PRIVATE_JSON_VALUE" },
			{ documentText: "" },
			{ documentText: null },
			// A corrupt server selection must not silently select a different global pack.
			{ documentText: "{PRIVATE_JSON_VALUE", globalPack: { language: "ko", messages: { Known: "전역 문구" } } },
		];
		for (const options of invalidOptions) {
			const rejected = browserSnapshot(options);
			expect(rejected.language).toBe("en");
			expect(rejected.documentLanguage).toBe("en");
			expect(rejected.messages).toEqual({});
			expect(rejected.translated).toEqual(["Known", "Missing", "Count one then two"]);
			expect(rejected.fetches).toBe(0);
			expect(rejected.errors).toEqual(["Could not load Korean language pack; using English."]);
			expect(JSON.stringify(rejected.errors)).not.toContain("PRIVATE_");
		}
	}, 30_000);

	it("clears a previously selected pack after a rejected or English reinitialization", () => {
		const modulePath = new URL("../src/i18n-browser.ts", import.meta.url).href;
		const script = `import {initializeI18n, getLanguage, getMessages, t} from ${JSON.stringify(modulePath)};
const errors = [];
console.error = (...values) => errors.push(values.join(" "));
globalThis.document = {getElementById: () => null, documentElement: {lang: "host"}};
globalThis.__OMP_I18N__ = {language: "ko", messages: {Known: "선택됨"}};
await initializeI18n();
const korean = [getLanguage(), t("Known"), document.documentElement.lang];
globalThis.__OMP_I18N__ = {language: "ko", messages: {PRIVATE_BAD_PACK: false}};
await initializeI18n();
const rejected = [getLanguage(), t("Known"), getMessages(), document.documentElement.lang];
globalThis.__OMP_I18N__ = {language: "ko", messages: {Known: "다시 선택됨"}};
await initializeI18n();
globalThis.__OMP_I18N__ = {language: "en"};
await initializeI18n();
console.log(JSON.stringify({korean, rejected, english: [getLanguage(), t("Known"), getMessages(), document.documentElement.lang], errors}));`;
		const child = Bun.spawnSync([process.execPath, "-e", script]);
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(JSON.parse(child.stdout.toString())).toEqual({
			korean: ["ko", "선택됨", "ko"],
			rejected: ["en", "Known", {}, "en"],
			english: ["en", "Known", {}, "en"],
			errors: ["Could not load Korean language pack; using English."],
		});
		expect(child.stderr.toString()).toBe("");
	});

	it("selects the pack before evaluating a React component's static translated labels", () => {
		const modulePath = new URL("../src/i18n-browser.ts", import.meta.url).href;
		const componentPath = new URL("../../collab-web/src/components/shell/ThemeToggle.tsx", import.meta.url).href;
		const messages = {
			"System theme": "시스템 모드",
			"{0} (click to switch)": "{0} (전환)",
			"{0} — click to switch": "{0} — 전환",
		};
		for (const language of ["en", "ko"]) {
			const script = `import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {initializeI18n} from ${JSON.stringify(modulePath)};
globalThis.__OMP_I18N__ = ${JSON.stringify({ language, messages })};
await initializeI18n();
// Static import would capture English labels before the host pack is initialized.
const {ThemeToggle} = await import(${JSON.stringify(componentPath)});
console.log(renderToStaticMarkup(createElement(ThemeToggle)));`;
			const child = Bun.spawnSync([process.execPath, "-e", script], {
				cwd: join(import.meta.dir, "../../collab-web"),
				env: { ...process.env, OMP_LANG: "ko", PI_COMPILED: undefined },
			});
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			const html = child.stdout.toString();
			expect(html).toContain(
				language === "ko" ? 'aria-label="시스템 모드 (전환)"' : 'aria-label="System theme (click to switch)"',
			);
			expect(html).toContain(
				language === "ko" ? 'title="시스템 모드 — 전환"' : 'title="System theme — click to switch"',
			);
			expect(child.stderr.toString()).toBe("");
		}
	});
});
