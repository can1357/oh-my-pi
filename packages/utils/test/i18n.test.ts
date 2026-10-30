import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "../src/i18n-core";

describe("language packs", () => {
	it("falls back to English for missing messages and inherited object properties", () => {
		const translate = createTranslator({ Known: "알려진 문구" });
		expect(translate("Known")).toBe("알려진 문구");
		expect(translate("New feature: {0}", "ready")).toBe("New feature: ready");
		expect(translate("toString")).toBe("toString");
	});

	it("reorders placeholders without interpreting replacement values", () => {
		const translate = createTranslator({ "{0} then {1}": "{1} 다음 {0}" });
		expect(translate("{0} then {1}", "$&{1}", "")).toBe(" 다음 $&{1}");
	});

	it("rejects malformed catalogs and foreign placeholders", () => {
		for (const invalid of [null, [], 3, { Ready: false }, { Ready: "{1}" }]) {
			expect(() => createTranslator(invalid)).toThrow();
		}
	});

	it("preserves contextual meanings and permits omitting English plural suffixes", () => {
		const translate = createTranslator({
			"Compact\u0004view": "간결",
			"Compact\u0004context": "압축",
			"{0} item{1}": "{0}개 항목",
		});
		expect(translate("Compact\u0004view")).toBe("간결");
		expect(translate("Compact\u0004context")).toBe("압축");
		expect(translate("Compact\u0004unknown")).toBe("Compact");
		expect(translate("{0} item{1}", "2", "s")).toBe("2개 항목");
	});

	it("keeps language-specific arguments even when English omits their indexes", () => {
		const translate = createTranslator({ "{1} {2}": "{0} {1}개" });
		expect(translate("{1} {2}", "파일", "2", "files")).toBe("파일 2개");
		expect(createTranslator({})("{1} {2}", "파일", "2", "files")).toBe("2 files");
	});

	it("loads an external Korean pack and falls back to English for its missing keys", () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-language-pack-"));
		try {
			writeFileSync(join(directory, "ko.json"), '\uFEFF{"Known":"외부 번역"}');
			const modulePath = new URL("../src/i18n.ts", import.meta.url).href;
			const script = `import {initializeI18n, t} from ${JSON.stringify(modulePath)}; await initializeI18n(); console.log(JSON.stringify([t("Known"), t("New {0}", "value")]));`;
			const run = (language: string | undefined) =>
				Bun.spawnSync([process.execPath, "-e", script], {
					env: { ...process.env, OMP_LANG: language, OMP_LOCALE_DIR: directory, PI_COMPILED: undefined },
				});
			const korean = run("ko-KR");
			expect(korean.exitCode).toBe(0);
			expect(JSON.parse(korean.stdout.toString())).toEqual(["외부 번역", "New value"]);
			for (const language of [undefined, "", "en", "en-US", "fr", "ko_KR", "ko.KR", "ko-KP", "ko-KR-extra"]) {
				const english = run(language);
				expect(english.exitCode).toBe(0);
				expect(JSON.parse(english.stdout.toString())).toEqual(["Known", "New value"]);
				expect(english.stderr.toString()).toBe("");
			}
			for (const invalid of ["{broken", "null", '{"Known":false}', '{"Known":"{1}"}']) {
				writeFileSync(join(directory, "ko.json"), invalid);
				const fallback = run("ko");
				expect(fallback.exitCode).toBe(0);
				expect(JSON.parse(fallback.stdout.toString())).toEqual(["Known", "New value"]);
				expect(fallback.stderr.toString()).toContain("using English");
				expect(run("en").stderr.toString()).toBe("");
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);

	it("does not read external packs until initialized and does not expose rejected contents", () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-language-import-"));
		try {
			writeFileSync(join(directory, "ko.json"), '{"PRIVATE_PACK_VALUE":false}');
			const modulePath = new URL("../src/i18n.ts", import.meta.url).href;
			const script = `import {initializeI18n, getLanguage, t} from ${JSON.stringify(modulePath)};
console.log(JSON.stringify([getLanguage(), t("Ready")]));
await initializeI18n();
console.log(JSON.stringify([getLanguage(), t("Ready")]));`;
			const child = Bun.spawnSync([process.execPath, "-e", script], {
				env: { ...process.env, OMP_LANG: "ko", OMP_LOCALE_DIR: directory, PI_COMPILED: undefined },
			});
			expect(child.exitCode).toBe(0);
			expect(
				child.stdout
					.toString()
					.trim()
					.split("\n")
					.map(line => JSON.parse(line)),
			).toEqual([
				["en", "Ready"],
				["en", "Ready"],
			]);
			expect(child.stderr.toString()).toContain("using English");
			expect(child.stderr.toString()).not.toContain("PRIVATE_PACK_VALUE");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("explicit language initialization", () => {
	it("does not access pack files on import or when English is selected", () => {
		const modulePath = new URL("../src/i18n.ts", import.meta.url).href;
		const script = `let reads = 0;
Bun.file = () => { reads++; throw new Error("UNEXPECTED_PACK_READ"); };
// Dynamic import is intentional: install the I/O tripwire before module evaluation.
const i18n = await import(${JSON.stringify(modulePath)});
const imported = [i18n.getLanguage(), i18n.t("Ready"), reads];
if (process.env.OMP_LANG !== "ko") await i18n.initializeI18n();
console.log(JSON.stringify({imported, selected: [i18n.getLanguage(), i18n.t("Ready"), reads]}));`;
		for (const language of [undefined, "", "en", "en-US", "fr", "ko"]) {
			const child = Bun.spawnSync([process.execPath, "-e", script], {
				env: { ...process.env, OMP_LANG: language, OMP_LOCALE_DIR: "UNREAD_PRIVATE_PATH", PI_COMPILED: undefined },
			});
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			expect(JSON.parse(child.stdout.toString())).toEqual({
				imported: ["en", "Ready", 0],
				selected: ["en", "Ready", 0],
			});
			expect(child.stderr.toString()).toBe("");
		}
	}, 30_000);

	it("loads the packaged source asset only after explicit Korean initialization", () => {
		const modulePath = new URL("../src/i18n.ts", import.meta.url).href;
		const script = `import {initializeI18n, getLanguage, getMessages, t} from ${JSON.stringify(modulePath)};
const before = [getLanguage(), t("Ready")];
await initializeI18n();
console.log(JSON.stringify({before, language: getLanguage(), ready: t("Ready"), hasMessages: Object.keys(getMessages()).length > 0}));`;
		const child = Bun.spawnSync([process.execPath, "-e", script], {
			env: { ...process.env, OMP_LANG: "ko", OMP_LOCALE_DIR: undefined, PI_COMPILED: undefined },
		});
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		expect(JSON.parse(child.stdout.toString())).toEqual({
			before: ["en", "Ready"],
			language: "ko",
			ready: "준비 완료",
			hasMessages: true,
		});
		expect(child.stderr.toString()).toBe("");
	});

	it("uses packs beside the executable only for compiled runs", () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-packaged-language-"));
		try {
			const runtime = join(directory, process.platform === "win32" ? "bun.exe" : "bun");
			copyFileSync(process.execPath, runtime);
			if (process.platform !== "win32") chmodSync(runtime, 0o755);
			mkdirSync(join(directory, "locales"));
			writeFileSync(join(directory, "locales/ko.json"), '{"Ready":"PACKAGED_EXTERNAL_TRANSLATION"}');
			const modulePath = new URL("../src/i18n.ts", import.meta.url).href;
			const script = `import {initializeI18n, getLanguage, t} from ${JSON.stringify(modulePath)};
await initializeI18n();
console.log(JSON.stringify([getLanguage(), t("Ready")]));`;
			for (const compiled of [undefined, "true"]) {
				const child = Bun.spawnSync([runtime, "-e", script], {
					env: { ...process.env, OMP_LANG: "ko", OMP_LOCALE_DIR: undefined, PI_COMPILED: compiled },
				});
				expect(child.exitCode, child.stderr.toString()).toBe(0);
				expect(JSON.parse(child.stdout.toString())).toEqual([
					"ko",
					compiled ? "PACKAGED_EXTERNAL_TRANSLATION" : "준비 완료",
				]);
				expect(child.stderr.toString()).toBe("");
			}
			rmSync(join(directory, "locales/ko.json"));
			const missing = Bun.spawnSync([runtime, "-e", script], {
				env: { ...process.env, OMP_LANG: "ko", OMP_LOCALE_DIR: undefined, PI_COMPILED: "true" },
			});
			expect(missing.exitCode).toBe(0);
			expect(JSON.parse(missing.stdout.toString())).toEqual(["en", "Ready"]);
			expect(missing.stderr.toString()).toContain("using English");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);

	it("falls back to English for missing or unreadable explicitly selected assets without a bundled fallback", () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-language-missing-"));
		try {
			const modulePath = new URL("../src/i18n.ts", import.meta.url).href;
			const script = `import {initializeI18n, getLanguage, getMessages, t} from ${JSON.stringify(modulePath)};
await initializeI18n();
console.log(JSON.stringify([getLanguage(), getMessages(), t("Ready")]));`;
			// A missing file and a path whose parent is a regular file exercise distinct read failures.
			for (const selected of [directory, join(directory, "PRIVATE_ASSET_PATH")]) {
				if (selected !== directory) writeFileSync(selected, "PRIVATE_ASSET_CONTENT");
				const child = Bun.spawnSync([process.execPath, "-e", script], {
					env: { ...process.env, OMP_LANG: "ko", OMP_LOCALE_DIR: selected, PI_COMPILED: undefined },
				});
				expect(child.exitCode, child.stderr.toString()).toBe(0);
				expect(JSON.parse(child.stdout.toString())).toEqual(["en", {}, "Ready"]);
				expect(child.stderr.toString().trim()).toBe("Could not load Korean language pack; using English.");
				expect(child.stderr.toString()).not.toContain("PRIVATE_ASSET");
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("resets translated messages when reinitialized in English or with a rejected pack", () => {
		const directory = mkdtempSync(join(tmpdir(), "omp-language-reset-"));
		try {
			writeFileSync(join(directory, "ko.json"), '{"Ready":"선택됨"}');
			const modulePath = new URL("../src/i18n.ts", import.meta.url).href;
			const script = `import {initializeI18n, getLanguage, getMessages, t} from ${JSON.stringify(modulePath)};
await initializeI18n();
const korean = [getLanguage(), t("Ready")];
process.env.OMP_LANG = "en";
await initializeI18n();
const english = [getLanguage(), t("Ready"), getMessages()];
process.env.OMP_LANG = "ko";
await initializeI18n();
process.env.OMP_LOCALE_DIR += "/MISSING_PRIVATE_PATH";
await initializeI18n();
console.log(JSON.stringify({korean, english, rejected: [getLanguage(), t("Ready"), getMessages()]}));`;
			const child = Bun.spawnSync([process.execPath, "-e", script], {
				env: { ...process.env, OMP_LANG: "ko", OMP_LOCALE_DIR: directory, PI_COMPILED: undefined },
			});
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			expect(JSON.parse(child.stdout.toString())).toEqual({
				korean: ["ko", "선택됨"],
				english: ["en", "Ready", {}],
				rejected: ["en", "Ready", {}],
			});
			expect(child.stderr.toString().trim()).toBe("Could not load Korean language pack; using English.");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
