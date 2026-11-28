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

/** The fabricated plugin set, in order. */
const PLUGIN_NAMES = ["Chrome PDF Plugin", "Chrome PDF Viewer", "Native Client"];
const PLUGIN_FILENAMES = ["internal-pdf-viewer", "mhjfbmdgcfjbbpaeojofohoefgiehjai", "internal-nacl-plugin"];
const PLUGIN_DESCRIPTIONS = ["Portable Document Format", "", ""];
const MIME_TYPE_TYPES = [
	"application/pdf",
	"application/x-google-chrome-pdf",
	"application/x-nacl",
	"application/x-pnacl",
];
const PLUGIN_MIME_TYPES = [
	["application/x-google-chrome-pdf"],
	["application/pdf"],
	["application/x-nacl", "application/x-pnacl"],
];

/**
 * An engine that reports no plugin support at all: the guard's `!("plugins" in navigator)` branch.
 * The native accessors are configurable, so removing them is what a stripped-down embedder looks like.
 */
const NO_PLUGIN_ACCESSORS = `//!world=main
(() => {
	delete Navigator.prototype.plugins;
	delete Navigator.prototype.mimeTypes;
})()`;

/** An engine whose PluginArray exists but is empty: the guard's `navigator.plugins.length === 0` branch. */
const EMPTY_PLUGIN_ARRAYS = `//!world=main
(() => {
	const empty = proto => Object.create(proto, {
		length: { value: 0, writable: false, enumerable: false, configurable: true },
	});
	Object.defineProperty(Navigator.prototype, "plugins", {
		get() { return empty(PluginArray.prototype); },
		enumerable: true,
		configurable: true,
	});
	Object.defineProperty(Navigator.prototype, "mimeTypes", {
		get() { return empty(MimeTypeArray.prototype); },
		enumerable: true,
		configurable: true,
	});
})()`;

/** An engine that reports no plugins because PDF viewing is unavailable. */
const PDF_VIEWING_OFF = `//!world=main
(() => {
	delete Navigator.prototype.plugins;
	delete Navigator.prototype.mimeTypes;
	const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "pdfViewerEnabled");
	Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", {
		get: () => false,
		enumerable: descriptor ? descriptor.enumerable : true,
		configurable: true,
	});
})()`;

interface Attempt<T = unknown> {
	ok: boolean;
	value?: T;
	error?: string;
}

interface FunctionReport {
	label: string;
	name: string;
	length: number;
	page: string;
	pristine: string;
}

interface DescriptorReport {
	writable?: boolean;
	enumerable: boolean;
	configurable: boolean;
	kind: "value" | "accessor";
}

interface PluginsReport {
	pluginsLength: number;
	mimeTypesLength: number;
	pluginNames: string[];
	pluginFilenames: string[];
	pluginDescriptions: string[];
	pluginLengths: number[];
	pluginMimeTypes: string[][];
	mimeTypeTypes: string[];
	mimeTypeSuffixes: string[];
	mimeEnabledNames: (string | null)[];
	tags: Record<"plugins" | "plugin" | "mimeTypes" | "mimeType", string>;
	instances: Record<"plugins" | "plugin" | "mimeTypes" | "mimeType" | "pluginCtor" | "mimeCtor", boolean>;
	prototypes: Record<"plugins" | "plugin" | "mimeTypes" | "mimeType", boolean>;
	iteration: {
		arrayFromPlugins: string[];
		arrayFromMimeTypes: string[];
		forOfPlugins: number;
		spreadPlugins: number;
		forOfMimeTypes: number;
		spreadMimeTypes: number;
		arrayFromPlugin: string[];
		forOfPlugin: number;
	};
	access: {
		index0: string;
		index2: string;
		outOfRange: boolean;
		negativeIndex: boolean;
		named: boolean;
		namedItem: string | null;
		item0: string;
		item2: string;
		itemOutOfRange: unknown;
		itemStringIndex: string;
		itemNegative: unknown;
		itemFractional: string;
		refreshType: string;
		refreshResult: Attempt;
	};
	shape: {
		pluginOwnNames: string[];
		pluginMimeOwnNames: string[];
		pluginKeys: string[];
		mimeOwnNames: string[];
		mimeKeys: string[];
		pluginsOwnNames: string[];
		pluginsKeys: string[];
		mimeTypesOwnNames: string[];
		mimeTypesKeys: string[];
		hasOwnLength: boolean;
		lengthDescriptor: DescriptorReport | null;
		json: string;
		string: string;
		stable: boolean;
	};
	descriptors: {
		index: DescriptorReport | null;
		pluginIndex: DescriptorReport | null;
		pluginMimeNamed: DescriptorReport | null;
		namedPlugin: DescriptorReport | null;
		namedMimeType: DescriptorReport | null;
		navigatorPlugins: DescriptorReport;
		navigatorMimeTypes: DescriptorReport;
	};
	functions: FunctionReport[];
	prototypeFunctions: { item: FunctionReport; refresh: FunctionReport };
	errors: {
		itemNoArg: Attempt;
		namedItemNoArg: Attempt;
		mimeItemNoArg: Attempt;
		mimeNamedItemNoArg: Attempt;
		itemBrand: Attempt<string>;
		protoItemBrand: Attempt;
		namedItemCoercion: Attempt<string | null>;
		getterBrand: Attempt<boolean>;
	};
	methods: {
		pluginItem: Attempt<string>;
		pluginNamedItem: Attempt<string>;
		pluginLengthGetter: Attempt<number>;
		mimeTypeGetter: Attempt<string>;
		arrayLengthGetter: Attempt<number>;
	};
	consistency: {
		mimeEnabledIsPlugin: boolean[][];
		enabledShared: boolean;
		pluginMimeSelf: boolean;
		pluginNamedMimeSame: boolean;
		pdfViewerEnabled: boolean;
	};
	getter: {
		reflectSource: string;
		reflectPristine: string;
		reflectName: string;
		objectSource: string;
		objectName: string;
		mimeReflectSource: string;
	};
}

const PROBE = `//!world=main
(() => {
	const frame = document.body.appendChild(document.createElement("iframe"));
	const pristineToString = frame.contentWindow.Function.prototype.toString;
	const pristine = fn => pristineToString.call(fn);
	const attempt = (fn) => {
		try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
	};
	const describe = (obj, prop) => {
		const d = Object.getOwnPropertyDescriptor(obj, prop);
		if (d === undefined) return null;
		return { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable, kind: "value" in d ? "value" : "accessor" };
	};
	const report = (label, fn) => ({ label, name: fn.name, length: fn.length, page: fn.toString(), pristine: pristine(fn) });

	// Captured first: the tampering patch only registers an accessor's source the first time
	// Object.getOwnPropertyDescriptor hands it out, so Reflect is the unmasked path.
	const reflectPlugins = Reflect.getOwnPropertyDescriptor(Navigator.prototype, "plugins");
	const reflectMimeTypes = Reflect.getOwnPropertyDescriptor(Navigator.prototype, "mimeTypes");
	// Read the sources now: a later Object.getOwnPropertyDescriptor call registers the getter in
	// the toString mask, after which the same function prints as native everywhere.
	const reflectSources = {
		plugins: reflectPlugins.get.toString(),
		pluginsPristine: pristine(reflectPlugins.get),
		pluginsName: reflectPlugins.get.name,
		mimeTypes: reflectMimeTypes.get.toString(),
	};

	const plugins = navigator.plugins;
	const mimeTypes = navigator.mimeTypes;
	const enabledPlugin = mime => (mime.enabledPlugin ? mime.enabledPlugin : null);
	const tag = value => Object.prototype.toString.call(value);
	const ownNames = value => Object.getOwnPropertyNames(value);
	const keys = value => Object.keys(value);
	const listed = (value, read) => Array.from({ length: value.length }, (_, index) => read(value[index], index));

	return {
		pluginsLength: plugins.length,
		mimeTypesLength: mimeTypes.length,
		pluginNames: listed(plugins, plugin => plugin.name),
		pluginFilenames: listed(plugins, plugin => plugin.filename),
		pluginDescriptions: listed(plugins, plugin => plugin.description),
		pluginLengths: listed(plugins, plugin => plugin.length),
		pluginMimeTypes: listed(plugins, plugin => listed(plugin, mime => mime.type)),
		mimeTypeTypes: listed(mimeTypes, mime => mime.type),
		mimeTypeSuffixes: listed(mimeTypes, mime => mime.suffixes),
		mimeEnabledNames: listed(mimeTypes, mime => (enabledPlugin(mime) ? enabledPlugin(mime).name : null)),
		tags: { plugins: tag(plugins), plugin: tag(plugins[0]), mimeTypes: tag(mimeTypes), mimeType: tag(mimeTypes[0]) },
		instances: {
			plugins: plugins instanceof PluginArray,
			plugin: plugins[0] instanceof Plugin,
			mimeTypes: mimeTypes instanceof MimeTypeArray,
			mimeType: mimeTypes[0] instanceof MimeType,
			pluginCtor: plugins[0].constructor === Plugin,
			mimeCtor: mimeTypes[0].constructor === MimeType,
		},
		prototypes: {
			plugins: Object.getPrototypeOf(plugins) === PluginArray.prototype,
			plugin: Object.getPrototypeOf(plugins[0]) === Plugin.prototype,
			mimeTypes: Object.getPrototypeOf(mimeTypes) === MimeTypeArray.prototype,
			mimeType: Object.getPrototypeOf(mimeTypes[0]) === MimeType.prototype,
		},
		iteration: {
			arrayFromPlugins: Array.from(plugins).map(plugin => plugin.name),
			arrayFromMimeTypes: Array.from(mimeTypes).map(mime => mime.type),
			forOfPlugins: (() => { let count = 0; for (const _ of plugins) count += 1; return count; })(),
			spreadPlugins: [...plugins].length,
			forOfMimeTypes: (() => { let count = 0; for (const _ of mimeTypes) count += 1; return count; })(),
			spreadMimeTypes: [...mimeTypes].length,
			arrayFromPlugin: Array.from(plugins[2]).map(mime => mime.type),
			forOfPlugin: (() => { let count = 0; for (const _ of plugins[2]) count += 1; return count; })(),
		},
		access: {
			index0: plugins[0].name,
			index2: plugins[2].name,
			outOfRange: plugins[3] === undefined,
			negativeIndex: plugins[-1] === undefined,
			named: plugins["Chrome PDF Viewer"] === plugins[1],
			namedItem: plugins.namedItem("Native Client") && plugins.namedItem("Native Client").name,
			item0: plugins.item(0).name,
			item2: plugins.item(2).name,
			itemOutOfRange: plugins.item(99),
			itemStringIndex: plugins.item("1").name,
			itemNegative: plugins.item(-1),
			itemFractional: plugins.item(1.5) && plugins.item(1.5).name,
			refreshType: typeof plugins.refresh,
			refreshResult: attempt(() => plugins.refresh()),
		},
		shape: {
			pluginOwnNames: ownNames(plugins[0]),
			pluginMimeOwnNames: ownNames(plugins[0]).filter(name => name.includes("/")),
			pluginKeys: keys(plugins[0]),
			mimeOwnNames: ownNames(mimeTypes[0]),
			mimeKeys: keys(mimeTypes[0]),
			pluginsOwnNames: ownNames(plugins),
			pluginsKeys: keys(plugins),
			mimeTypesOwnNames: ownNames(mimeTypes),
			mimeTypesKeys: keys(mimeTypes),
			hasOwnLength: Object.prototype.hasOwnProperty.call(plugins, "length"),
			lengthDescriptor: describe(plugins, "length"),
			json: JSON.stringify(plugins),
			string: String(plugins),
			stable: navigator.plugins === plugins && navigator.mimeTypes === mimeTypes,
		},
		descriptors: {
			index: describe(plugins, "0"),
			pluginIndex: describe(plugins[0], "0"),
			pluginMimeNamed: describe(plugins[0], "application/x-google-chrome-pdf"),
			namedPlugin: describe(plugins, "Chrome PDF Plugin"),
			namedMimeType: describe(mimeTypes, "application/pdf"),
			navigatorPlugins: {
				enumerable: reflectPlugins.enumerable,
				configurable: reflectPlugins.configurable,
				kind: "accessor",
			},
			navigatorMimeTypes: {
				enumerable: reflectMimeTypes.enumerable,
				configurable: reflectMimeTypes.configurable,
				kind: "accessor",
			},
		},
		functions: [
			report("plugins.item", plugins.item),
			report("plugins.namedItem", plugins.namedItem),
			report("plugins.refresh", plugins.refresh),
			report("mimeTypes.item", mimeTypes.item),
			report("mimeTypes.namedItem", mimeTypes.namedItem),
		],
		prototypeFunctions: {
			item: report("PluginArray.prototype.item", PluginArray.prototype.item),
			refresh: report("PluginArray.prototype.refresh", PluginArray.prototype.refresh),
		},
		errors: {
			itemNoArg: attempt(() => plugins.item()),
			namedItemNoArg: attempt(() => plugins.namedItem()),
			mimeItemNoArg: attempt(() => mimeTypes.item()),
			mimeNamedItemNoArg: attempt(() => mimeTypes.namedItem()),
			itemBrand: attempt(() => plugins.item.call({}, 0).name),
			protoItemBrand: attempt(() => PluginArray.prototype.item.call({}, 0)),
			namedItemCoercion: attempt(() => {
				const found = plugins.namedItem(new String("Chrome PDF Viewer"));
				return found && found.name;
			}),
			getterBrand: attempt(() => Object.getOwnPropertyDescriptor(Navigator.prototype, "plugins").get.call({}) === plugins),
		},
		methods: {
			pluginItem: attempt(() => plugins[0].item(0).type),
			pluginNamedItem: attempt(() => plugins[0].namedItem("application/x-google-chrome-pdf").type),
			pluginLengthGetter: attempt(() => Object.getOwnPropertyDescriptor(Plugin.prototype, "length").get.call(plugins[0])),
			mimeTypeGetter: attempt(() => Object.getOwnPropertyDescriptor(MimeType.prototype, "type").get.call(mimeTypes[0])),
			arrayLengthGetter: attempt(() => Object.getOwnPropertyDescriptor(PluginArray.prototype, "length").get.call(plugins)),
		},
		consistency: {
			mimeEnabledIsPlugin: listed(mimeTypes, mime => listed(plugins, plugin => mime.enabledPlugin === plugin)),
			enabledShared: mimeTypes[0].enabledPlugin === mimeTypes[1].enabledPlugin,
			pluginMimeSelf: plugins[0][0].enabledPlugin === plugins[0],
			pluginNamedMimeSame: plugins[0]["application/x-google-chrome-pdf"] === mimeTypes["application/x-google-chrome-pdf"],
			pdfViewerEnabled: navigator.pdfViewerEnabled,
		},
		getter: {
			reflectSource: reflectSources.plugins,
			reflectPristine: reflectSources.pluginsPristine,
			reflectName: reflectSources.pluginsName,
			objectSource: Object.getOwnPropertyDescriptor(Navigator.prototype, "plugins").get.toString(),
			objectName: Object.getOwnPropertyDescriptor(Navigator.prototype, "plugins").get.name,
			mimeReflectSource: reflectSources.mimeTypes,
		},
	};
})()`;

interface GuardReport {
	pluginCount: number;
	pluginNames: string[];
	mimeTypeTypes: string[];
	itemIdentity: boolean;
	itemIdentityMime: boolean;
	getterName: string;
	getterSource: string;
	pluginItem: string | null;
	indexWritable: boolean | undefined;
	pdfViewerEnabled: boolean;
}

const GUARD_PROBE = `//!world=main
(() => {
	const plugins = navigator.plugins;
	const mimeTypes = navigator.mimeTypes;
	const attempt = (fn) => { try { return fn(); } catch { return null; } };
	return {
		pluginCount: plugins.length,
		pluginNames: Array.from({ length: plugins.length }, (_, index) => plugins[index].name),
		mimeTypeTypes: Array.from({ length: mimeTypes.length }, (_, index) => mimeTypes[index].type),
		itemIdentity: plugins.item === PluginArray.prototype.item,
		itemIdentityMime: mimeTypes.item === MimeTypeArray.prototype.item,
		getterName: Object.getOwnPropertyDescriptor(Navigator.prototype, "plugins").get.name,
		getterSource: Object.getOwnPropertyDescriptor(Navigator.prototype, "plugins").get.toString(),
		pluginItem: attempt(() => plugins[0].item(0).type),
		indexWritable: Object.getOwnPropertyDescriptor(plugins, "0").writable,
		pdfViewerEnabled: navigator.pdfViewerEnabled,
	};
})()`;

const PDF_OFF_PROBE = `//!world=main
(() => ({
	pdfViewerEnabled: navigator.pdfViewerEnabled,
	pluginNames: Array.from({ length: navigator.plugins.length }, (_, index) => navigator.plugins[index].name),
	mimeTypeTypes: Array.from({ length: navigator.mimeTypes.length }, (_, index) => navigator.mimeTypes[index].type),
}))()`;

const CONTROL_PROBE = `//!world=main
(() => ({
	pluginsType: typeof navigator.plugins,
	mimeTypesType: typeof navigator.mimeTypes,
	pluginsLength: navigator.plugins ? navigator.plugins.length : null,
	mimeTypesLength: navigator.mimeTypes ? navigator.mimeTypes.length : null,
}))()`;

interface NativeSnapshot {
	ua: string;
	pluginCount: number;
	pluginNames: string[];
	mimeTypeTypes: string[];
	pdfViewerEnabled: boolean;
	pluginsGetterName: string;
	pluginsGetterSource: string;
	pluginsEnumerable: boolean;
	pluginsConfigurable: boolean;
	indexWritable: boolean | undefined;
	pluginItem: string | null;
	enabledShared: boolean | null;
	namedItemCoerces: boolean;
	itemFractional: string | null;
}

const NATIVE_PROBE = `//!world=main
(() => {
	const plugins = navigator.plugins;
	const mimeTypes = navigator.mimeTypes;
	const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, "plugins");
	const attempt = (fn) => { try { return { ok: true, value: fn() }; } catch { return { ok: false }; } };
	return {
		ua: navigator.userAgent,
		pluginCount: plugins.length,
		pluginNames: Array.from({ length: plugins.length }, (_, index) => plugins[index].name),
		mimeTypeTypes: Array.from({ length: mimeTypes.length }, (_, index) => mimeTypes[index].type),
		pdfViewerEnabled: navigator.pdfViewerEnabled,
		pluginsGetterName: descriptor.get.name,
		pluginsGetterSource: descriptor.get.toString(),
		pluginsEnumerable: descriptor.enumerable,
		pluginsConfigurable: descriptor.configurable,
		indexWritable: Object.getOwnPropertyDescriptor(plugins, "0").writable,
		pluginItem: attempt(() => plugins[0].item(0).type).value ?? null,
		enabledShared: mimeTypes.length > 1 ? mimeTypes[0].enabledPlugin === mimeTypes[1].enabledPlugin : null,
		namedItemCoerces: attempt(() => plugins.namedItem(new String(plugins[0].name)).name).ok,
		itemFractional: attempt(() => plugins.item(1.5).name).value ?? null,
	};
})()`;

let server: Server<undefined> | undefined;
let launched: LaunchHeadlessResult | undefined;
let native: NativeSnapshot | undefined;

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("<!doctype html><title>plugins</title>", { headers: { "content-type": "text/html" } }),
	});
	launched = await launchHeadlessBrowser({ headless: true });
	native = (await readNative()) as NativeSnapshot;
}, 60_000);

afterAll(async () => {
	if (launched) await closeLaunchedBrowser(launched);
	server?.stop(true);
});

/** Opens a page with the given document-start scripts, then reads it in the main world. */
async function open<T>(prescripts: readonly string[], scripts: string | undefined, probe: string): Promise<T> {
	if (!launched || !server) throw new Error("browser not ready");
	const page: Page = await launched.browser.newPage();
	try {
		for (const prescript of prescripts) await page.evaluateOnNewDocument(prescript);
		if (scripts) await page.evaluateOnNewDocument(scripts);
		await page.goto(server.url.href);
		return (await page.evaluate(probe)) as T;
	} finally {
		await page.close();
	}
}

async function readNative(): Promise<NativeSnapshot> {
	return await open<NativeSnapshot>([], undefined, NATIVE_PROBE);
}

/**
 * The patch as the stealth pipeline builds it. Without `STEALTH_SCRIPTS.plugins` in this
 * bootstrap every assertion below loses its subject: on an engine with no plugin support the
 * accessor stays missing, so this file fails rather than silently passing.
 */
async function readPatched(emptyArrays = false): Promise<PluginsReport> {
	return await open<PluginsReport>(
		[emptyArrays ? EMPTY_PLUGIN_ARRAYS : NO_PLUGIN_ACCESSORS],
		buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.plugins]),
		PROBE,
	);
}

describe.skipIf(!CHROMIUM_AVAILABLE)("stealth plugins patch", () => {
	it("supplies non-empty PluginArray and MimeTypeArray on an engine that reports none", async () => {
		const report = await readPatched();

		expect(report.pluginsLength).toBe(PLUGIN_NAMES.length);
		expect(report.mimeTypesLength).toBe(MIME_TYPE_TYPES.length);
		expect(report.pluginNames).toEqual(PLUGIN_NAMES);
		expect(report.pluginFilenames).toEqual(PLUGIN_FILENAMES);
		expect(report.pluginDescriptions).toEqual(PLUGIN_DESCRIPTIONS);
		expect(report.pluginLengths).toEqual([1, 1, 2]);
		expect(report.pluginMimeTypes).toEqual(PLUGIN_MIME_TYPES);
		expect(report.mimeTypeTypes).toEqual(MIME_TYPE_TYPES);
		expect(report.mimeTypeSuffixes).toEqual(["pdf", "pdf", "", ""]);
		expect(report.mimeEnabledNames).toEqual([
			"Chrome PDF Viewer",
			"Chrome PDF Plugin",
			"Native Client",
			"Native Client",
		]);
	}, 30_000);

	it("behaves like a native PluginArray for access, iteration and own-key shape", async () => {
		const report = await readPatched();

		expect(report.tags).toEqual({
			plugins: "[object PluginArray]",
			plugin: "[object Plugin]",
			mimeTypes: "[object MimeTypeArray]",
			mimeType: "[object MimeType]",
		});
		expect(report.instances).toEqual({
			plugins: true,
			plugin: true,
			mimeTypes: true,
			mimeType: true,
			pluginCtor: true,
			mimeCtor: true,
		});
		expect(report.prototypes).toEqual({ plugins: true, plugin: true, mimeTypes: true, mimeType: true });

		expect(report.iteration).toEqual({
			arrayFromPlugins: PLUGIN_NAMES,
			arrayFromMimeTypes: MIME_TYPE_TYPES,
			forOfPlugins: 3,
			spreadPlugins: 3,
			forOfMimeTypes: 4,
			spreadMimeTypes: 4,
			arrayFromPlugin: ["application/x-nacl", "application/x-pnacl"],
			forOfPlugin: 2,
		});

		expect(report.access).toMatchObject({
			index0: "Chrome PDF Plugin",
			index2: "Native Client",
			outOfRange: true,
			negativeIndex: true,
			named: true,
			namedItem: "Native Client",
			item0: "Chrome PDF Plugin",
			item2: "Native Client",
			itemOutOfRange: null,
			itemStringIndex: "Chrome PDF Viewer",
			itemNegative: null,
			refreshType: "function",
		});
		expect(report.access.refreshResult.ok).toBe(true);

		// The visible own-key shape matches a native PluginArray: indices and named entries on the
		// array, indices and MIME names on a plugin, nothing own on a MimeType, hidden length.
		expect(report.shape).toMatchObject({
			pluginMimeOwnNames: ["application/x-google-chrome-pdf"],
			mimeOwnNames: [],
			mimeKeys: [],
			pluginsKeys: ["0", "1", "2"],
			mimeTypesKeys: ["0", "1", "2", "3"],
			hasOwnLength: false,
			lengthDescriptor: null,
			string: "[object PluginArray]",
			stable: true,
		});
		expect(report.shape.pluginsOwnNames).toEqual([
			"0",
			"1",
			"2",
			"Chrome PDF Plugin",
			"Chrome PDF Viewer",
			"Native Client",
		]);
		expect(report.shape.mimeTypesOwnNames).toEqual(["0", "1", "2", "3", ...MIME_TYPE_TYPES]);
		expect(report.shape.json).toBe('{"0":{"0":{}},"1":{"0":{}},"2":{"0":{},"1":{}}}');

		// WebIDL's arity errors are reproduced verbatim for both arrays.
		expect(report.errors).toMatchObject({
			itemNoArg: {
				ok: false,
				error: "Failed to execute 'item' on 'PluginArray': 1 argument required, but only 0 present.",
			},
			namedItemNoArg: {
				ok: false,
				error: "Failed to execute 'namedItem' on 'PluginArray': 1 argument required, but only 0 present.",
			},
			mimeItemNoArg: {
				ok: false,
				error: "Failed to execute 'item' on 'MimeTypeArray': 1 argument required, but only 0 present.",
			},
			mimeNamedItemNoArg: {
				ok: false,
				error: "Failed to execute 'namedItem' on 'MimeTypeArray': 1 argument required, but only 0 present.",
			},
		});
	}, 30_000);

	it("prints every function it hands out as native code in the page realm", async () => {
		const report = await readPatched();

		expect(report.functions.map(fn => fn.label)).toEqual([
			"plugins.item",
			"plugins.namedItem",
			"plugins.refresh",
			"mimeTypes.item",
			"mimeTypes.namedItem",
		]);
		for (const fn of report.functions) {
			const name = fn.label.split(".")[1];
			expect(fn.name).toBe(name);
			expect(fn.length).toBe(name === "refresh" ? 0 : 1);
			expect(fn.page).toBe(`function ${name}() { [native code] }`);
			// A Proxy prints anonymously through a pristine realm's own toString: the known,
			// accepted tell that the realm's registry does not know these functions.
			expect(fn.pristine).toBe("function () { [native code] }");
		}

		// The prototype methods themselves are untouched natives.
		for (const fn of [report.prototypeFunctions.item, report.prototypeFunctions.refresh]) {
			const name = fn.label.split(".")[2];
			expect(fn.page).toBe(`function ${name}() { [native code] }`);
			expect(fn.pristine).toBe(`function ${name}() { [native code] }`);
		}

		// Data descriptors that do not come from the patch keep native attributes.
		expect(report.descriptors.namedPlugin).toEqual({
			writable: false,
			enumerable: false,
			configurable: true,
			kind: "value",
		});
		expect(report.descriptors.namedMimeType).toEqual({
			writable: false,
			enumerable: false,
			configurable: true,
			kind: "value",
		});
		expect(report.descriptors.pluginMimeNamed).toEqual({
			writable: false,
			enumerable: false,
			configurable: true,
			kind: "value",
		});
	}, 30_000);

	it("keeps mimeTypes consistent with plugins", async () => {
		const report = await readPatched();

		// Each MIME type's enabledPlugin is a fresh Proxy around its plugin, so identity with the
		// Plugin object itself is lost for all four entries.
		expect(report.consistency.mimeEnabledIsPlugin).toEqual([
			[false, false, false],
			[false, false, false],
			[false, false, false],
			[false, false, false],
		]);
		expect(report.consistency.pdfViewerEnabled).toBe(true);
		expect(report.consistency.pluginNamedMimeSame).toBe(true);
		expect(report.consistency.pluginMimeSelf).toBe(false);

		// Every MIME type names a real plugin, and every plugin's own MIME entries name it back.
		for (let index = 0; index < report.mimeTypeTypes.length; index += 1) {
			const name = report.mimeEnabledNames[index];
			expect(PLUGIN_NAMES).toContain(name as string);
			const owner = PLUGIN_NAMES.indexOf(name as string);
			expect(report.pluginMimeTypes[owner]).toContain(report.mimeTypeTypes[index]);
		}
	}, 30_000);

	it("advertises PDF plugins even where the engine reports PDF viewing off", async () => {
		// The usual reason an engine reports no plugins is that PDF viewing is disabled. The patch
		// does not read pdfViewerEnabled, so it adds PDF viewers beside a false flag.
		const report = await open<{
			pdfViewerEnabled: boolean;
			pluginNames: string[];
			mimeTypeTypes: string[];
		}>([PDF_VIEWING_OFF], buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.plugins]), PDF_OFF_PROBE);
		expect(report.pdfViewerEnabled).toBe(false);
		expect(report.pluginNames).toEqual(PLUGIN_NAMES);
		expect(report.mimeTypeTypes).toContain("application/pdf");
	}, 30_000);

	it("fires when the engine reports plugins but the array is empty", async () => {
		const report = await readPatched(true);
		expect(report.pluginsLength).toBe(PLUGIN_NAMES.length);
		expect(report.mimeTypesLength).toBe(MIME_TYPE_TYPES.length);
		expect(report.pluginNames).toEqual(PLUGIN_NAMES);
		expect(report.getter.objectName).toBe("get plugins");
	}, 30_000);

	it("leaves a browser that already reports plugins untouched", async () => {
		const report = await open<GuardReport>(
			[],
			buildStealthInjectionScriptForTest([STEALTH_SCRIPTS.plugins]),
			GUARD_PROBE,
		);
		expect(native).toBeDefined();
		const reference = native as NativeSnapshot;

		// The probe saw the real plugin list, so the patch must not have replaced anything: a
		// second, different list here would mean the guard fired on a healthy engine.
		expect(report.pluginCount).toBeGreaterThan(0);
		expect(report.pluginCount).toBe(reference.pluginCount);
		expect(report.pluginNames).toEqual(reference.pluginNames);
		expect(report.mimeTypeTypes).toEqual(reference.mimeTypeTypes);
		expect(report.itemIdentity).toBe(true);
		expect(report.itemIdentityMime).toBe(true);
		expect(report.getterName).toBe(reference.pluginsGetterName);
		expect(report.getterName).toBe("get plugins");
		expect(report.getterSource).toBe("function get plugins() { [native code] }");
		expect(report.pluginItem).toBe(reference.pluginItem);
		expect(report.indexWritable).toBe(reference.indexWritable);
	}, 30_000);

	it("is the only source of the arrays: without it the accessors stay missing or empty", async () => {
		const missing = await open<{
			pluginsType: string;
			mimeTypesType: string;
			pluginsLength: number | null;
			mimeTypesLength: number | null;
		}>([NO_PLUGIN_ACCESSORS], buildStealthInjectionScriptForTest([]), CONTROL_PROBE);
		expect(missing).toEqual({
			pluginsType: "undefined",
			mimeTypesType: "undefined",
			pluginsLength: null,
			mimeTypesLength: null,
		});

		const empty = await open<{
			pluginsType: string;
			mimeTypesType: string;
			pluginsLength: number | null;
			mimeTypesLength: number | null;
		}>([EMPTY_PLUGIN_ARRAYS], buildStealthInjectionScriptForTest([]), CONTROL_PROBE);
		expect(empty).toEqual({
			pluginsType: "object",
			mimeTypesType: "object",
			pluginsLength: 0,
			mimeTypesLength: 0,
		});
	}, 30_000);

	/**
	 * The patch is a static fingerprint, so the deltas it still leaves against the engine's own
	 * PluginArray are asserted here rather than hidden: each one is a detection vector the audit
	 * records as open, and each flips when the proposed fix lands.
	 */
	it("records the tells it still leaves against a native PluginArray", async () => {
		const report = await readPatched();
		const reference = native as NativeSnapshot;

		// Navigator.prototype: the patch's accessor now carries native flags and a named getter.
		expect(report.descriptors.navigatorPlugins).toEqual({ enumerable: true, configurable: true, kind: "accessor" });
		expect(reference.pluginsEnumerable).toBe(true);
		expect(reference.pluginsConfigurable).toBe(true);
		expect(report.getter.reflectName).toBe("get plugins");
		expect(report.getter.objectName).toBe("get plugins");
		expect(reference.pluginsGetterName).toBe("get plugins");
		// The accessor is now registered in the mask, so reflection no longer exposes its body.
		expect(report.getter.reflectSource).not.toContain("return value");
		// A pristine realm has its own registry, so it still reads the getter's JS body: open tell.
		expect(report.getter.reflectPristine).toContain("return value");
		expect(report.getter.mimeReflectSource).not.toContain("return value");
		// Object.getOwnPropertyDescriptor masks the getter lazily through the tampering patch, so
		// the same function prints native through one API and as source through Reflect.
		expect(report.getter.objectSource).toBe("function get plugins() { [native code] }");
		expect(reference.pluginsGetterSource).toBe("function get plugins() { [native code] }");

		// Indexed properties are writable here, read-only natively.
		expect(report.descriptors.index).toEqual({ writable: true, enumerable: true, configurable: true, kind: "value" });
		expect(report.descriptors.pluginIndex).toEqual({
			writable: true,
			enumerable: true,
			configurable: true,
			kind: "value",
		});
		expect(reference.indexWritable).toBe(false);

		// Inherited Plugin methods are brand-checked against the real slot, which a Proxy lacks.
		expect(report.methods.pluginItem).toEqual({ ok: false, error: "Illegal invocation" });
		expect(report.methods.pluginNamedItem).toEqual({ ok: false, error: "Illegal invocation" });
		expect(report.methods.pluginLengthGetter).toEqual({ ok: false, error: "Illegal invocation" });
		expect(report.methods.mimeTypeGetter).toEqual({ ok: false, error: "Illegal invocation" });
		expect(report.methods.arrayLengthGetter).toEqual({ ok: false, error: "Illegal invocation" });
		expect(reference.pluginItem).toBe("application/pdf");

		// The item/namedItem proxies ignore their receiver and truncate instead of coercing.
		expect(report.errors.itemBrand).toEqual({ ok: true, value: "Chrome PDF Plugin" });
		expect(report.errors.protoItemBrand.ok).toBe(false);
		expect(report.errors.getterBrand).toEqual({ ok: true, value: true });
		expect(report.errors.namedItemCoercion).toEqual({ ok: true, value: null });
		expect(reference.namedItemCoerces).toBe(true);
		expect(report.access.itemFractional).toBe("Chrome PDF Plugin");
		expect(reference.itemFractional).toBe("Chrome PDF Viewer");

		// enabledPlugin is a fresh Proxy per MIME type, so identity with the plugin (and between
		// the two PDF MIME types) is lost.
		expect(report.consistency.enabledShared).toBe(false);
		expect(reference.enabledShared).toBe(true);

		// The fabricated list is the Chrome-66-era trio; this Chromium reports another set. The
		// "Native Client" plugin and application/x-nacl were removed from Chrome long before the
		// Chrome version the stealth override claims, and text/pdf is missing.
		expect(report.pluginNames).not.toEqual(reference.pluginNames);
		expect(report.pluginNames).toContain("Native Client");
		expect(reference.pluginNames).not.toContain("Native Client");
		expect(report.mimeTypeTypes).toContain("application/x-nacl");
		expect(reference.mimeTypeTypes).not.toContain("application/x-nacl");
		expect(reference.mimeTypeTypes).toContain("text/pdf");
		expect(report.mimeTypeTypes).not.toContain("text/pdf");
		expect(reference.ua).toContain("Chrome/");
	}, 30_000);
});
