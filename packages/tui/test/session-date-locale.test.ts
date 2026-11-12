import { describe, expect, it } from "bun:test";
import { systemDateLocale } from "../src/overlays/session-selector";

describe("systemDateLocale", () => {
	// A POSIX `en_GB.UTF-8` is not a valid BCP 47 tag; `toLocaleDateString` would throw or ignore it.
	it("turns a POSIX locale into a BCP 47 tag that formats dates day-first", () => {
		const locale = systemDateLocale({ LANG: "en_GB.UTF-8" });
		expect(locale).toBe("en-GB");
		expect(new Date(2026, 9, 13).toLocaleDateString(locale)).toBe("13/10/2026");
	});

	// POSIX precedence: a user who sets `LC_TIME` must beat `LANG`, and `LC_ALL` beats both.
	it("prefers LC_ALL over LC_TIME over LANG", () => {
		expect(systemDateLocale({ LC_ALL: "fr_FR.UTF-8", LC_TIME: "de_DE.UTF-8", LANG: "en_GB.UTF-8" })).toBe("fr-FR");
		expect(systemDateLocale({ LC_TIME: "de_DE.UTF-8", LANG: "en_GB.UTF-8" })).toBe("de-DE");
	});

	// `C` means "no locale"; falling through to `LANG` would contradict `LC_ALL`.
	it("returns undefined for C, POSIX, unset and unparsable values so the runtime default applies", () => {
		expect(systemDateLocale({ LC_ALL: "C.UTF-8", LANG: "de_DE.UTF-8" })).toBeUndefined();
		expect(systemDateLocale({ LANG: "POSIX" })).toBeUndefined();
		expect(systemDateLocale({})).toBeUndefined();
		expect(systemDateLocale({ LANG: "garbage_@@" })).toBeUndefined();
	});
});
