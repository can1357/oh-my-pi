import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	buildStealthInjectionScriptForTest,
	closeLaunchedBrowser,
	type LaunchHeadlessResult,
	launchHeadlessBrowser,
	STEALTH_SCRIPTS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { Server } from "bun";
import type { Page } from "puppeteer-core";
import { chromiumAvailable } from "../chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

interface QueryCase {
	label: string;
	query: string;
	/** The answer the patch promises; a query without one must reach the browser unchanged. */
	patched?: "probably" | "maybe";
}

/**
 * The three branches of the patch, then queries it must leave alone: the baseline codec is only
 * recognised as the quoted, exact string it names, so the unquoted, other-profile, whitespace and
 * `audio/mp4` forms below all fall through and are recorded by the audit.
 */
const CASES: readonly QueryCase[] = [
	{ label: "avc1 quoted", query: 'video/mp4; codecs="avc1.42E01E"', patched: "probably" },
	{ label: "avc1 with aac", query: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', patched: "probably" },
	{ label: "avc1 unquoted", query: "video/mp4; codecs=avc1.42E01E" },
	{ label: "avc1 main profile", query: 'video/mp4; codecs="avc1.4D401E"' },
	{ label: "space before semicolon", query: 'video/mp4 ; codecs="avc1.42E01E"' },
	{ label: "aac bare", query: "audio/aac", patched: "probably" },
	{ label: "m4a bare", query: "audio/x-m4a", patched: "maybe" },
	{ label: "m4a with codecs", query: 'audio/x-m4a; codecs="mp4a.40.2"' },
	{ label: "mp4 with aac codecs", query: 'audio/mp4; codecs="mp4a.40.2"' },
	{ label: "mp4 container", query: "video/mp4" },
	{ label: "webm vp9", query: 'video/webm; codecs="vp9"' },
	{ label: "ogg theora", query: 'video/ogg; codecs="theora"' },
	{ label: "empty", query: "" },
	{ label: "nonsense", query: "nonsense" },
	{ label: "uppercase mime", query: 'VIDEO/MP4; CODECS="AVC1.42E01E"' },
];

type ReportedCase = QueryCase & { patched: "probably" | "maybe" };
const REPORTED: readonly ReportedCase[] = CASES.filter(
	(queryCase): queryCase is ReportedCase => queryCase.patched !== undefined,
);

interface CodecsReport {
	answers: Record<string, string>;
	mse: Record<string, boolean | string>;
	mediaCapabilities: Record<string, boolean | string>;
	odd: Record<string, string>;
	source: { page: string; pristine: string };
	pristineToString: string;
	shape: {
		name: string;
		length: number;
		writable: boolean | undefined;
		enumerable: boolean | undefined;
		configurable: boolean | undefined;
		getType: string;
		setType: string;
	};
	prototype: {
		ownKeys: string[];
		canPlayTypeIndex: number;
		prototypeOfIsFunctionPrototype: boolean;
		constructorIsFunction: boolean;
		hasOwnPrototype: boolean;
		stringTag: string;
	};
	sourceBuffer: { opened: boolean; added: Record<string, string> } | "unavailable";
}

/**
 * Runs in the page's main world, where the bootstrap preloaded its patches. The fresh iframe is
 * created here so `Function.prototype.toString` comes from a realm the page never touched.
 */
const probe = (cases: readonly QueryCase[]) => `//!world=main
(async () => {
	const queries = ${JSON.stringify(cases.map(({ label, query }) => ({ label, query })))};
	const frame = document.body.appendChild(document.createElement("iframe"));
	const pristineToString = frame.contentWindow.Function.prototype.toString;
	const pristineGetOwnPropertyDescriptor = frame.contentWindow.Object.getOwnPropertyDescriptor;
	const canPlayType = HTMLMediaElement.prototype.canPlayType;
	const video = document.createElement("video");
	const answers = {};
	const mse = {};
	for (const { label, query } of queries) {
		try {
			answers[label] = video.canPlayType(query);
		} catch (error) {
			answers[label] = "THREW:" + error.name;
		}
		try {
			mse[label] = window.MediaSource ? MediaSource.isTypeSupported(query) : "unavailable";
		} catch (error) {
			mse[label] = "THREW:" + error.name;
		}
	}

	// Native canPlayType converts each argument to a string; the patch reads it as one.
	const odd = {};
	const attempt = (label, run) => {
		try {
			odd[label] = run();
		} catch (error) {
			odd[label] = "THREW:" + error.name;
		}
	};
	attempt("undefined", () => video.canPlayType(undefined));
	attempt("null", () => video.canPlayType(null));
	attempt("number", () => video.canPlayType(123));
	attempt("boolean", () => video.canPlayType(true));
	attempt("object", () => video.canPlayType({}));
	attempt("objectToString", () => video.canPlayType({ toString: () => "video/mp4" }));
	attempt("symbol", () => video.canPlayType(Symbol("codecs")));
	attempt("noargs", () => video.canPlayType());

	const sourceBuffer = await (async () => {
		if (!window.MediaSource) return "unavailable";
		const media = document.createElement("video");
		const mediaSource = new MediaSource();
		media.src = URL.createObjectURL(mediaSource);
		// The real signal is sourceopen; the timer only keeps a broken MediaSource from hanging the test.
		const { promise, resolve } = Promise.withResolvers();
		const timer = setTimeout(() => resolve(false), 2000);
		mediaSource.addEventListener(
			"sourceopen",
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			{ once: true },
		);
		const opened = await promise;
		if (!opened) return { opened: false, added: {} };
		const added = {};
		const types = [
			["avc1", 'video/mp4; codecs="avc1.42E01E"'],
			["aac", "audio/aac"],
			["vp9", 'video/webm; codecs="vp9"'],
			["theora", 'video/ogg; codecs="theora"'],
		];
		for (const [label, type] of types) {
			try {
				mediaSource.addSourceBuffer(type);
				added[label] = "added";
			} catch (error) {
				added[label] = "THREW:" + error.name;
			}
		}
		return { opened: true, added };
	})();

	// The same decoder capability through the modern API: a build without the codecs answers here
	// too, so a patched canPlayType that disagrees with it is visible.
	const mediaCapabilities = {};
	if (navigator.mediaCapabilities) {
		const configurations = [
			["avc1", 'video/mp4; codecs="avc1.42E01E"', false],
			["aac", "audio/aac", true],
			["vp9", 'video/webm; codecs="vp9"', false],
		];
		for (const [label, contentType, isAudio] of configurations) {
			try {
				const configuration = isAudio
					? { type: "file", audio: { contentType, channels: 2, samplerate: 44100, bitrate: 128000 } }
					: { type: "file", video: { contentType, width: 1920, height: 1080, bitrate: 4000000, framerate: 30 } };
				mediaCapabilities[label] = (await navigator.mediaCapabilities.decodingInfo(configuration)).supported;
			} catch (error) {
				mediaCapabilities[label] = "THREW:" + error.name;
			}
		}
	}

	const descriptor = pristineGetOwnPropertyDescriptor(HTMLMediaElement.prototype, "canPlayType");
	const ownKeys = Object.getOwnPropertyNames(HTMLMediaElement.prototype);
	const report = {
		answers,
		mse,
		mediaCapabilities,
		odd,
		source: { page: canPlayType.toString(), pristine: pristineToString.call(canPlayType) },
		pristineToString: pristineToString.call(Function.prototype.toString),
		shape: {
			name: descriptor.value.name,
			length: descriptor.value.length,
			writable: descriptor.writable,
			enumerable: descriptor.enumerable,
			configurable: descriptor.configurable,
			getType: typeof descriptor.get,
			setType: typeof descriptor.set,
		},
		prototype: {
			ownKeys,
			canPlayTypeIndex: ownKeys.indexOf("canPlayType"),
			prototypeOfIsFunctionPrototype: Object.getPrototypeOf(canPlayType) === Function.prototype,
			constructorIsFunction: canPlayType.constructor === Function,
			hasOwnPrototype: "prototype" in canPlayType,
			stringTag: Object.prototype.toString.call(canPlayType),
		},
		sourceBuffer,
	};
	frame.remove();
	return report;
})()`;

/**
 * A build whose own decoders lack H.264 and AAC, which is the only case the patch exists for.
 * Without it the queries the patch names return the empty string, as they do on Chromium.
 */
const NO_PROPRIETARY_CODECS = `(() => {
	const proprietary = /avc1|mp4a|aac/i;
	const nativeCanPlayType = HTMLMediaElement.prototype.canPlayType;
	Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", {
		value: function canPlayType(type) {
			if (proprietary.test(String(type))) return "";
			return nativeCanPlayType.call(this, type);
		},
		writable: true,
		configurable: true,
		enumerable: true,
	});
	const nativeIsTypeSupported = window.MediaSource && MediaSource.isTypeSupported;
	if (nativeIsTypeSupported) {
		Object.defineProperty(MediaSource, "isTypeSupported", {
			value: function isTypeSupported(type) {
				if (proprietary.test(String(type))) return false;
				return nativeIsTypeSupported.call(this, type);
			},
			writable: true,
			configurable: true,
		});
	}
})();`;

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("<!doctype html><title>codecs</title>", { headers: { "content-type": "text/html" } }),
	});
	launched = await launchHeadlessBrowser({ headless: true });
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
});

/** Opens a page with the chosen bootstrap preloaded, then probes it in the main world. */
async function open(scripts: readonly string[], preludes: readonly string[] = []): Promise<CodecsReport> {
	if (!launched || !server) throw new Error("browser not ready");
	const page: Page = await launched.browser.newPage();
	try {
		for (const prelude of preludes) await page.evaluateOnNewDocument(prelude);
		await page.evaluateOnNewDocument(buildStealthInjectionScriptForTest(scripts));
		await page.goto(server.url.href);
		return (await page.evaluate(probe(CASES))) as CodecsReport;
	} finally {
		await page.close();
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("stealth codecs patch", () => {
	it("answers the promised codecs and passes every other query through untouched", async () => {
		const native = await open([]);
		const patched = await open([STEALTH_SCRIPTS.codecs]);

		// A query the patch does not name must keep the answer the browser itself gives.
		for (const { label, patched: expected } of CASES) {
			if (expected !== undefined) continue;
			expect({ label, answer: patched.answers[label] }).toEqual({ label, answer: native.answers[label] });
		}
		for (const { label, patched: expected } of REPORTED) {
			expect({ label, answer: patched.answers[label] }).toEqual({ label, answer: expected });
		}
		// The empty string is malformed input: both paths hand it to the browser, which says no.
		expect(patched.answers.empty).toBe("");
		expect(native.answers.empty).toBe("");
	}, 30_000);

	it("repairs a browser whose decoders lack H.264 and AAC", async () => {
		const legacy = await open([], [NO_PROPRIETARY_CODECS]);
		const repaired = await open([STEALTH_SCRIPTS.codecs], [NO_PROPRIETARY_CODECS]);

		// The emulation really is codec-less: without the patch the named queries come back empty.
		for (const { label } of REPORTED) {
			expect({ label, answer: legacy.answers[label] }).toEqual({
				label,
				answer: label === "m4a bare" ? "maybe" : "",
			});
		}
		for (const { label, patched: expected } of REPORTED) {
			expect({ label, answer: repaired.answers[label] }).toEqual({ label, answer: expected });
		}
		// MediaSource is never touched, so the repair claims H.264 support the rest of the platform
		// still denies on this build: the cross-API disagreement the audit records.
		expect({ canPlayType: repaired.answers["avc1 quoted"], isTypeSupported: repaired.mse["avc1 quoted"] }).toEqual({
			canPlayType: "probably",
			isTypeSupported: false,
		});
		// Everything the patch does not name is still the codec-less browser's own answer.
		for (const { label, patched: expected } of CASES) {
			if (expected !== undefined) continue;
			expect({ label, answer: repaired.answers[label] }).toEqual({ label, answer: legacy.answers[label] });
		}
	}, 30_000);

	it("prints as a native function and keeps the prototype's shape", async () => {
		const native = await open([]);
		const patched = await open([STEALTH_SCRIPTS.codecs]);

		expect(patched.source.page).toBe("function canPlayType() { [native code] }");
		expect(patched.shape).toEqual(native.shape);
		expect(patched.prototype).toEqual(native.prototype);

		// The replacement is a Proxy over the native: a pristine realm renders it anonymously, which
		// is the known, accepted tell. Its presence is what proves the replacement is installed.
		expect(patched.source.pristine).toBe("function () { [native code] }");
		expect(patched.pristineToString).toBe("function () { [native code] }");
		expect(native.source.pristine).toBe("function canPlayType() { [native code] }");
		expect(native.pristineToString).toBe("function toString() { [native code] }");
	}, 30_000);

	it("leaves MediaSource and SourceBuffer answers alone, so the agreement is visible", async () => {
		const native = await open([]);
		const patched = await open([STEALTH_SCRIPTS.codecs]);

		// The patch does not touch MediaSource or MediaCapabilities: on a build with the codecs they
		// agree, and on one without them canPlayType says "probably" while both still say no (audit).
		expect(patched.mse).toEqual(native.mse);
		expect(patched.mediaCapabilities).toEqual(native.mediaCapabilities);
		expect(patched.sourceBuffer).toEqual(native.sourceBuffer);

		if (native.answers["avc1 quoted"] === "probably") {
			expect(patched.mediaCapabilities.avc1).toBe(true);
			expect(patched.sourceBuffer).not.toBe("unavailable");
			if (patched.sourceBuffer !== "unavailable") {
				expect(patched.sourceBuffer.opened).toBe(true);
				expect(patched.sourceBuffer.added.avc1).toBe("added");
				expect(patched.sourceBuffer.added.aac).toBe("added");
			}
		}
	}, 30_000);

	it("documents how odd arguments diverge from the native conversion", async () => {
		const native = await open([]);
		const patched = await open([STEALTH_SCRIPTS.codecs]);

		// WebIDL converts every argument to a string, so the native answers "" for all of them.
		expect(native.odd).toEqual({
			undefined: "",
			null: "",
			number: "",
			boolean: "",
			object: "",
			objectToString: "maybe",
			symbol: "THREW:TypeError",
			noargs: "THREW:TypeError",
		});
		// Non-string arguments now go to the native method, so the patch matches the WebIDL conversion
		// exactly instead of throwing `trim is not a function`.
		expect(patched.odd).toEqual(native.odd);
	}, 30_000);
});
