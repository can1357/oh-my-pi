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

/**
 * A software renderer is the case the patch exists for: its raw vendor/renderer name is
 * `Google Inc. (Google)` / SwiftShader, so the unmasked enums must come back as the platform
 * profile. On a truthful hardware GPU the patch rewrites nothing and the file would prove little.
 */
const SOFTWARE_RENDERER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/** The fallback pairs baked into the patch, keyed by the platform it detects. */
const PLATFORM_PROFILES = {
	android: { vendor: "Qualcomm", renderer: "Adreno (TM) 640" },
	ios: { vendor: "Apple Inc.", renderer: "Apple GPU" },
	mac: {
		vendor: "Google Inc. (Intel Inc.)",
		renderer: "ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640 OpenGL Engine, OpenGL 4.1)",
	},
	windows: {
		vendor: "Google Inc. (Intel)",
		renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
	},
	cros: {
		vendor: "Google Inc. (Intel)",
		renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
	},
	linux: {
		vendor: "Google Inc. (Intel)",
		renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
	},
} as const;

type PlatformKind = keyof typeof PLATFORM_PROFILES;

interface PropertyShape {
	kind: "data" | "accessor";
	writable?: boolean;
	enumerable?: boolean;
	configurable?: boolean;
	valueType?: string;
	getType?: string;
	setType?: string;
}

interface MethodShape {
	/** Printed by a fresh same-origin iframe's `Function.prototype.toString`. */
	pristine: string;
	/** Printed by the page's own `Function.prototype.toString`. */
	page: string;
	name: string;
	length: number;
	ownKeys: string[];
	symbols: number;
	prototypeIsFunctionPrototype: boolean;
	instanceofFunction: boolean;
	nameDescriptor: PropertyShape | null;
	lengthDescriptor: PropertyShape | null;
}

interface PrecisionEntry {
	shader: string;
	type: string;
	values: unknown[];
	error: string | null;
	ownKeys: string[];
	symbols: number;
	prototypeIsNative: boolean;
	instanceofNative: boolean;
	constructorIsNative: boolean;
	prototypeOwnKeys: string[];
}

interface ExtensionReport {
	supported: string[];
	debug: {
		vendorEnum: number;
		rendererEnum: number;
		ownKeys: string[];
		prototypeIsObjectPrototype: boolean;
		unmaskedVendor: unknown;
		unmaskedRenderer: unknown;
	} | null;
	anisotropicStable: boolean;
	anisotropicKeys: string[] | null;
	absentIsNull: boolean;
	legacyVendor: unknown;
	legacyRenderer: unknown;
}

interface VersionReport {
	contextPrototypeIsNative: boolean;
	contextInstanceofNative: boolean;
	prototypeOwnKeys: string[];
	prototypeSymbols: string[];
	methods: Record<
		"getParameter" | "getShaderPrecisionFormat" | "getExtension" | "getSupportedExtensions",
		MethodShape
	>;
	methodDescriptors: Record<
		"getParameter" | "getShaderPrecisionFormat" | "getExtension" | "getSupportedExtensions",
		PropertyShape | null
	>;
	parameters: Record<string, unknown>;
	invalidEnum: { value: unknown; error: number };
	missingArgument: string | null;
	badReceiver: string | null;
	precisions: PrecisionEntry[];
	extensions: ExtensionReport;
}

interface Report {
	platform: string;
	userAgentDataPlatform: string;
	userAgent: string;
	functionToString: MethodShape;
	functionToStringDescriptor: PropertyShape | null;
	versions: { webgl: VersionReport | null; webgl2: VersionReport | null };
}

const PATCHED = buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.webgl]);
const CONTROL = buildStealthInjectionScriptForTest([]);

const PROBE = `//!world=main
(() => {
	const frame = document.body.appendChild(document.createElement("iframe"));
	frame.style.display = "none";
	// A fresh same-origin realm keeps the browser's own Function.prototype.toString, so a call
	// through it shows what the unwitting page would print for any function, patched or not.
	const pristineToString = frame.contentWindow.Function.prototype.toString;
	const pristine = (fn) => pristineToString.call(fn);

	const propertyShape = (descriptor) => {
		if (!descriptor) return null;
		return {
			kind: "value" in descriptor ? "data" : "accessor",
			writable: descriptor.writable,
			enumerable: descriptor.enumerable,
			configurable: descriptor.configurable,
			valueType: typeof descriptor.value,
			getType: typeof descriptor.get,
			setType: typeof descriptor.set,
		};
	};

	const methodShape = (fn) => ({
		pristine: pristine(fn),
		page: fn.toString(),
		name: fn.name,
		length: fn.length,
		ownKeys: Object.getOwnPropertyNames(fn).sort(),
		symbols: Object.getOwnPropertySymbols(fn).length,
		prototypeIsFunctionPrototype: Object.getPrototypeOf(fn) === Function.prototype,
		instanceofFunction: fn instanceof Function,
		nameDescriptor: propertyShape(Object.getOwnPropertyDescriptor(fn, "name")),
		lengthDescriptor: propertyShape(Object.getOwnPropertyDescriptor(fn, "length")),
	});

	const serialize = (value) => {
		if (value === null || typeof value !== "object") return value;
		if (ArrayBuffer.isView(value)) return { kind: value.constructor.name, values: Array.from(value) };
		if (Array.isArray(value)) return { kind: "array", values: value.slice() };
		return { kind: "object", text: String(value) };
	};

	const PARAMETERS = [
		"VENDOR",
		"RENDERER",
		"VERSION",
		"SHADING_LANGUAGE_VERSION",
		"MAX_TEXTURE_SIZE",
		"MAX_CUBE_MAP_TEXTURE_SIZE",
		"MAX_RENDERBUFFER_SIZE",
		"MAX_VIEWPORT_DIMS",
		"MAX_TEXTURE_IMAGE_UNITS",
		"MAX_VERTEX_TEXTURE_IMAGE_UNITS",
		"MAX_COMBINED_TEXTURE_IMAGE_UNITS",
		"MAX_VERTEX_ATTRIBS",
		"MAX_VERTEX_UNIFORM_VECTORS",
		"MAX_VARYING_VECTORS",
		"MAX_FRAGMENT_UNIFORM_VECTORS",
		"ALIASED_LINE_WIDTH_RANGE",
		"ALIASED_POINT_SIZE_RANGE",
		"DEPTH_BITS",
		"STENCIL_BITS",
		"RED_BITS",
		"GREEN_BITS",
		"BLUE_BITS",
		"ALPHA_BITS",
		"SUBPIXEL_BITS",
		"SAMPLES",
		"SAMPLE_BUFFERS",
		"DEPTH_CLEAR_VALUE",
		"STENCIL_CLEAR_VALUE",
		"COLOR_CLEAR_VALUE",
		"COLOR_WRITEMASK",
		"SCISSOR_BOX",
		"VIEWPORT",
		"UNPACK_ALIGNMENT",
		"PACK_ALIGNMENT",
		"IMPLEMENTATION_COLOR_READ_FORMAT",
		"IMPLEMENTATION_COLOR_READ_TYPE",
		"MAX_3D_TEXTURE_SIZE",
		"MAX_ARRAY_TEXTURE_LAYERS",
		"MAX_TEXTURE_LOD_BIAS",
		"MAX_ELEMENT_INDEX",
		"MAX_DRAW_BUFFERS",
		"MAX_UNIFORM_BUFFER_BINDINGS",
		"MAX_COMBINED_UNIFORM_BLOCKS",
		"UNIFORM_BUFFER_OFFSET_ALIGNMENT",
	];
	const SHADER_TYPES = ["VERTEX_SHADER", "FRAGMENT_SHADER"];
	const PRECISION_TYPES = ["LOW_FLOAT", "MEDIUM_FLOAT", "HIGH_FLOAT", "LOW_INT", "MEDIUM_INT", "HIGH_INT"];

	const describePrecision = (result) => {
		const values = [];
		let error = null;
		for (const key of ["rangeMin", "rangeMax", "precision"]) {
			try {
				values.push(result[key]);
			} catch (thrown) {
				values.push("throw:" + thrown.name);
				if (!error) error = thrown.name + ": " + thrown.message;
			}
		}
		return {
			values,
			error,
			ownKeys: Object.getOwnPropertyNames(result).sort(),
			symbols: Object.getOwnPropertySymbols(result).length,
			prototypeIsNative: Object.getPrototypeOf(result) === WebGLShaderPrecisionFormat.prototype,
			instanceofNative: result instanceof WebGLShaderPrecisionFormat,
			constructorIsNative: result.constructor === WebGLShaderPrecisionFormat,
			prototypeOwnKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(result)).sort(),
		};
	};

	const describeVersion = (kind) => {
		const gl = document.createElement("canvas").getContext(kind);
		if (!gl) return null;
		const proto = Object.getPrototypeOf(gl);
		const Context = kind === "webgl" ? window.WebGLRenderingContext : window.WebGL2RenderingContext;

		const parameters = {};
		for (const name of PARAMETERS) {
			const pname = gl[name];
			if (pname === undefined) continue;
			let value;
			try {
				value = serialize(gl.getParameter(pname));
			} catch (thrown) {
				value = "throw:" + thrown.name;
			}
			parameters[name] = value;
		}

		// Native WebIDL conversion, missing-argument and brand-check behaviour.
		for (let drained = 0; drained < 8 && gl.getError() !== gl.NO_ERROR; drained += 1) {}
		const invalidValue = gl.getParameter(0x1234);
		const invalidError = gl.getError();
		const failure = (invoke) => {
			try {
				invoke();
				return null;
			} catch (thrown) {
				return thrown.constructor.name + ": " + thrown.message;
			}
		};
		const missingArgument = failure(() => Reflect.apply(gl.getParameter, gl, []));
		const badReceiver = failure(() => Reflect.apply(gl.getParameter, {}, [gl.VENDOR]));

		const precisions = [];
		for (const shader of SHADER_TYPES) {
			for (const type of PRECISION_TYPES) {
				const result = gl.getShaderPrecisionFormat(gl[shader], gl[type]);
				precisions.push({
					shader,
					type,
					...(result ? describePrecision(result) : { values: [], error: "no result", ownKeys: [], symbols: 0, prototypeIsNative: false, instanceofNative: false, constructorIsNative: false, prototypeOwnKeys: [] }),
				});
			}
		}

		const debug = gl.getExtension("WEBGL_debug_renderer_info");
		const anisotropic = gl.getExtension("EXT_texture_filter_anisotropic");

		return {
			contextPrototypeIsNative: Context ? proto === Context.prototype : false,
			contextInstanceofNative: Context ? gl instanceof Context : false,
			prototypeOwnKeys: Object.getOwnPropertyNames(proto).sort(),
			prototypeSymbols: Object.getOwnPropertySymbols(proto).map(String),
			methods: {
				getParameter: methodShape(proto.getParameter),
				getShaderPrecisionFormat: methodShape(proto.getShaderPrecisionFormat),
				getExtension: methodShape(proto.getExtension),
				getSupportedExtensions: methodShape(proto.getSupportedExtensions),
			},
			methodDescriptors: {
				getParameter: propertyShape(Object.getOwnPropertyDescriptor(proto, "getParameter")),
				getShaderPrecisionFormat: propertyShape(Object.getOwnPropertyDescriptor(proto, "getShaderPrecisionFormat")),
				getExtension: propertyShape(Object.getOwnPropertyDescriptor(proto, "getExtension")),
				getSupportedExtensions: propertyShape(Object.getOwnPropertyDescriptor(proto, "getSupportedExtensions")),
			},
			parameters,
			invalidEnum: { value: serialize(invalidValue), error: invalidError },
			missingArgument,
			badReceiver,
			precisions,
			extensions: {
				supported: gl.getSupportedExtensions(),
				debug: debug
					? {
							vendorEnum: debug.UNMASKED_VENDOR_WEBGL,
							rendererEnum: debug.UNMASKED_RENDERER_WEBGL,
							ownKeys: Object.getOwnPropertyNames(debug).sort(),
							prototypeIsObjectPrototype: Object.getPrototypeOf(debug) === Object.prototype,
							unmaskedVendor: serialize(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)),
							unmaskedRenderer: serialize(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)),
						}
					: null,
				anisotropicStable: anisotropic !== null && gl.getExtension("EXT_texture_filter_anisotropic") === anisotropic,
				anisotropicKeys: anisotropic ? Object.getOwnPropertyNames(anisotropic).sort() : null,
				absentIsNull: gl.getExtension("KHR_absent_extension") === null,
				legacyVendor: serialize(gl.getParameter(gl.VENDOR)),
				legacyRenderer: serialize(gl.getParameter(gl.RENDERER)),
			},
		};
	};

	const report = {
		platform: String(navigator.platform || ""),
		userAgentDataPlatform: String(navigator.userAgentData?.platform || ""),
		userAgent: String(navigator.userAgent || ""),
		functionToString: methodShape(Function.prototype.toString),
		functionToStringDescriptor: propertyShape(Object.getOwnPropertyDescriptor(Function.prototype, "toString")),
		versions: { webgl: describeVersion("webgl"), webgl2: describeVersion("webgl2") },
	};
	frame.remove();
	return report;
})()`;

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("<!doctype html><title>webgl</title>", { headers: { "content-type": "text/html" } }),
	});
	launched = await launchHeadlessBrowser({ headless: true, args: SOFTWARE_RENDERER_ARGS });
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
});

/** Opens a page with the chosen bootstrap preloaded, then probes it in the main world. */
async function probe(scripts: string): Promise<Report> {
	if (!launched || !server) throw new Error("browser not ready");
	const page: Page = await launched.browser.newPage();
	try {
		await page.evaluateOnNewDocument(scripts);
		await page.goto(server.url.href);
		return (await page.evaluate(PROBE)) as Report;
	} finally {
		await page.close();
	}
}

let cached: Promise<{ patched: Report; control: Report }> | undefined;
function reports(): Promise<{ patched: Report; control: Report }> {
	cached ??= Promise.all([probe(PATCHED), probe(CONTROL)]).then(([patched, control]) => ({ patched, control }));
	return cached;
}

/** The platform kind the patch derives from `navigator.userAgentData.platform || navigator.platform` + UA. */
function platformKind(report: Report): PlatformKind {
	const text = `${report.userAgentDataPlatform || report.platform} ${report.userAgent}`.toLowerCase();
	if (text.includes("android")) return "android";
	if (text.includes("iphone") || text.includes("ipad") || text.includes("ipod")) return "ios";
	if (text.includes("mac")) return "mac";
	if (text.includes("win")) return "windows";
	if (text.includes("cros")) return "cros";
	return "linux";
}

function versionOf(report: Report, kind: "webgl" | "webgl2"): VersionReport {
	const version = report.versions[kind];
	if (!version) throw new Error(`${kind} context unavailable`);
	return version;
}

const NATIVE_METHOD = (name: string) => `function ${name}() { [native code] }`;

describe.skipIf(!CHROMIUM_AVAILABLE)("stealth webgl patch", () => {
	it("reports the platform's GPU profile from both WebGL versions and no other change", async () => {
		const { patched, control } = await reports();
		const profile = PLATFORM_PROFILES[platformKind(patched)];

		for (const kind of ["webgl", "webgl2"] as const) {
			const spoofed = versionOf(patched, kind);
			const native = versionOf(control, kind);
			const label = { version: kind };

			// Premise: the same browser, without the patch, advertises the software backend.
			expect({ ...label, ...native.extensions.debug }).toMatchObject({
				...label,
				unmaskedVendor: "Google Inc. (Google)",
				unmaskedRenderer: expect.stringContaining("SwiftShader"),
			});

			// The unmasked pair is the chosen profile; the legacy pair stays what WebGL always says.
			expect({
				...label,
				vendor: spoofed.extensions.debug?.unmaskedVendor,
				renderer: spoofed.extensions.debug?.unmaskedRenderer,
				legacyVendor: spoofed.extensions.legacyVendor,
				legacyRenderer: spoofed.extensions.legacyRenderer,
			}).toEqual({
				...label,
				vendor: profile.vendor,
				renderer: profile.renderer,
				legacyVendor: "WebKit",
				legacyRenderer: "WebKit WebGL",
			});

			// Every other parameter, plus error and argument-conversion behaviour, is untouched.
			expect({ ...label, parameters: spoofed.parameters }).toEqual({ ...label, parameters: native.parameters });
			expect({ ...label, invalidEnum: spoofed.invalidEnum }).toEqual({ ...label, invalidEnum: native.invalidEnum });
			expect({ ...label, missingArgument: spoofed.missingArgument }).toEqual({
				...label,
				missingArgument: native.missingArgument,
			});
			expect({ ...label, badReceiver: spoofed.badReceiver }).toEqual({
				...label,
				badReceiver: native.badReceiver,
			});
			expect(spoofed.contextPrototypeIsNative).toBe(true);
			expect(spoofed.contextInstanceofNative).toBe(true);
		}
	}, 30_000);

	it("keeps getParameter's native shape on both prototypes and masks it through toString", async () => {
		const { patched, control } = await reports();

		for (const kind of ["webgl", "webgl2"] as const) {
			const spoofed = versionOf(patched, kind);
			const native = versionOf(control, kind);
			const label = { version: kind };

			expect({ ...label, descriptors: spoofed.methodDescriptors }).toEqual({
				...label,
				descriptors: native.methodDescriptors,
			});
			expect({ ...label, ownKeys: spoofed.prototypeOwnKeys }).toEqual({
				...label,
				ownKeys: native.prototypeOwnKeys,
			});
			expect({ ...label, symbols: spoofed.prototypeSymbols }).toEqual({
				...label,
				symbols: native.prototypeSymbols,
			});
			expect({ ...label, methods: spoofed.methods.getParameter }).toEqual({
				...label,
				methods: {
					pristine: NATIVE_METHOD("getParameter"),
					page: NATIVE_METHOD("getParameter"),
					name: "getParameter",
					length: 1,
					ownKeys: ["length", "name"],
					symbols: 0,
					prototypeIsFunctionPrototype: true,
					instanceofFunction: true,
					nameDescriptor: {
						kind: "data",
						writable: false,
						enumerable: false,
						configurable: true,
						valueType: "string",
						getType: "undefined",
						setType: "undefined",
					},
					lengthDescriptor: {
						kind: "data",
						writable: false,
						enumerable: false,
						configurable: true,
						valueType: "number",
						getType: "undefined",
						setType: "undefined",
					},
				},
			});

			// A pristine realm cannot see the source registry, so a Proxy prints without its target's
			// name; the page's masked toString is the path that prints the name. Dropping the patch
			// makes the pristine call print the named native string too, which fails the assertion above.
			expect({ ...label, pristine: native.methods.getParameter.pristine }).toEqual({
				...label,
				pristine: NATIVE_METHOD("getParameter"),
			});
			expect({ ...label, page: native.methods.getParameter.page }).toEqual({
				...label,
				page: NATIVE_METHOD("getParameter"),
			});
			expect({
				...label,
				name: native.methods.getParameter.name,
				length: native.methods.getParameter.length,
			}).toEqual({
				...label,
				name: "getParameter",
				length: 1,
			});
		}

		// Function.prototype.toString itself is the mask: registered through the page, anonymous to a
		// pristine realm, with the descriptor flags it always had.
		expect(patched.functionToStringDescriptor).toEqual(control.functionToStringDescriptor);
		expect({ name: patched.functionToString.name, length: patched.functionToString.length }).toEqual({
			name: "toString",
			length: 0,
		});
		expect(patched.functionToString.page).toBe(NATIVE_METHOD("toString"));
		expect(patched.functionToString.pristine).toBe("function toString() { [native code] }");
		expect(control.functionToString.page).toBe(NATIVE_METHOD("toString"));
		expect(control.functionToString.pristine).toBe(NATIVE_METHOD("toString"));
	}, 30_000);

	it("leaves getExtension, getSupportedExtensions and shader precision native", async () => {
		const { patched, control } = await reports();
		const profile = PLATFORM_PROFILES[platformKind(patched)];

		for (const kind of ["webgl", "webgl2"] as const) {
			const spoofed = versionOf(patched, kind);
			const native = versionOf(control, kind);
			const label = { version: kind };

			// Extension surface: same list, same extension objects and constants; only the two unmasked
			// enums differ.
			expect({ ...label, supported: spoofed.extensions.supported }).toEqual({
				...label,
				supported: native.extensions.supported,
			});
			expect({ ...label, debug: spoofed.extensions.debug }).toMatchObject({
				...label,
				debug: {
					vendorEnum: 37445,
					rendererEnum: 37446,
					unmaskedVendor: profile.vendor,
					unmaskedRenderer: profile.renderer,
				},
			});
			expect({
				...label,
				debug: {
					...spoofed.extensions.debug,
					unmaskedVendor: null,
					unmaskedRenderer: null,
				},
			}).toEqual({
				...label,
				debug: {
					...native.extensions.debug,
					unmaskedVendor: null,
					unmaskedRenderer: null,
				},
			});
			expect({ ...label, anisotropicStable: spoofed.extensions.anisotropicStable }).toEqual({
				...label,
				anisotropicStable: true,
			});
			expect({ ...label, anisotropicKeys: spoofed.extensions.anisotropicKeys }).toEqual({
				...label,
				anisotropicKeys: native.extensions.anisotropicKeys,
			});
			expect({ ...label, absentIsNull: spoofed.extensions.absentIsNull }).toEqual({
				...label,
				absentIsNull: true,
			});

			// Precision formats: same numbers and native result shape as the unpatched page.
			expect({ ...label, precisions: spoofed.precisions }).toEqual({ ...label, precisions: native.precisions });
			for (const entry of spoofed.precisions) {
				const entryLabel = { ...label, shader: entry.shader, type: entry.type };
				expect({ ...entryLabel, error: entry.error }).toEqual({ ...entryLabel, error: null });
				expect({ ...entryLabel, values: entry.values.map(value => typeof value) }).toEqual({
					...entryLabel,
					values: ["number", "number", "number"],
				});
				expect({ ...entryLabel, prototypeIsNative: entry.prototypeIsNative }).toEqual({
					...entryLabel,
					prototypeIsNative: true,
				});
				expect({ ...entryLabel, instanceofNative: entry.instanceofNative }).toEqual({
					...entryLabel,
					instanceofNative: true,
				});
			}

			// The extension methods are untouched; the precision method is proxied like getParameter.
			expect(spoofed.methods.getExtension).toEqual(native.methods.getExtension);
			expect(spoofed.methods.getSupportedExtensions).toEqual(native.methods.getSupportedExtensions);
			expect(spoofed.methods.getExtension.pristine).toBe(NATIVE_METHOD("getExtension"));
			expect(spoofed.methods.getSupportedExtensions.pristine).toBe(NATIVE_METHOD("getSupportedExtensions"));
			expect({ ...label, precisionMethod: spoofed.methods.getShaderPrecisionFormat }).toEqual({
				...label,
				precisionMethod: {
					...native.methods.getShaderPrecisionFormat,
					pristine: NATIVE_METHOD("getShaderPrecisionFormat"),
					page: NATIVE_METHOD("getShaderPrecisionFormat"),
				},
			});
		}
	}, 30_000);
});
