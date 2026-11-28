import { type } from "@oh-my-pi/omptype";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "../tool-errors";
import type { Device, Frame, NetworkConditions, Page, Permission } from "puppeteer-core";
import { pressKey } from "./interactions";
import { applyViewport } from "./launch";

import { type EmulationViewport, viewportSchema } from "./viewport";

export type { EmulationViewport } from "./viewport";
export { viewportSchema } from "./viewport";

/** Coordinates accepted by runtime geolocation emulation. */
export interface EmulationGeolocation {
	/** Latitude in decimal degrees. */
	latitude: number;
	/** Longitude in decimal degrees. */
	longitude: number;
	/** Position accuracy in meters. */
	accuracy?: number;
}

/** HTTP basic-auth credentials applied to the page. */
export interface EmulationCredentials {
	/** Basic-auth username. */
	username: string;
	/** Basic-auth password. */
	password: string;
}

/** Custom network throughput in bytes per second plus latency in milliseconds. */
export interface EmulationNetworkConditions {
	/** Download throughput in bytes per second. */
	download: number;
	/** Upload throughput in bytes per second. */
	upload: number;
	/** Request latency in milliseconds. */
	latency: number;
}

/** Independently mergeable device, network, and media overrides for a browser tab. */
export interface BrowserEmulateOptions {
	/** Override viewport dimensions. */
	viewport?: EmulationViewport;
	/** Emulate a Puppeteer `KnownDevices` profile. */
	device?: string;
	/** Override coordinates, or clear the override with `null`. */
	geolocation?: EmulationGeolocation | null;
	/** Toggle offline mode. */
	offline?: boolean;
	/** Override the preferred color scheme. */
	colorScheme?: "dark" | "light" | "no-preference";
	/** Toggle reduced-motion preference (`tab.emulate()` also takes `"reduce"`/`"no-preference"`). */
	reducedMotion?: boolean;
	/** Emulate the CSS media type, or clear it with `null`. */
	media?: "screen" | "print" | null;
	/** Set extra HTTP headers, or clear them with `null`. */
	headers?: Record<string, string> | null;
	/** Set HTTP basic-auth credentials, or clear them with `null`. */
	credentials?: EmulationCredentials | null;
	/** Set a user agent, or clear it with `null` while retaining an active device UA. */
	userAgent?: string | null;
	/** Set an ICU timezone, or clear it with `null`. */
	timezone?: string | null;
	/** Set a locale, or clear it with `null`. */
	locale?: string | null;
	/** Set a CPU slowdown factor, or clear it with `null`. */
	cpuThrottling?: number | null;
	/** Set a network preset/custom profile, or clear it with `null`. */
	network?: "slow3g" | "fast3g" | EmulationNetworkConditions | null;
}

/** Result of a clipboard operation, identifying whether Chromium or the worker shim handled it. */
export interface ClipboardActionResult {
	/** Chromium page clipboard or in-worker round-trip shim. */
	source: "page" | "shim";
}

/** Clipboard text plus the source that supplied it. */
export interface ClipboardReadResult extends ClipboardActionResult {
	/** Clipboard plain text. */
	text: string;
}

const emulateOptionsSchema = type({
	"viewport?": viewportSchema,
	"device?": "string",
	"geolocation?": type({ latitude: "number", longitude: "number", "accuracy?": "number", "+": "reject" }).or("null"),
	"offline?": "boolean",
	"colorScheme?": "'dark' | 'light' | 'no-preference'",
	"reducedMotion?": "boolean | 'reduce' | 'no-preference'",
	"media?": "'screen' | 'print' | null",
	"headers?": type("Record<string, string>").or("null"),
	"credentials?": type({ username: "string", password: "string", "+": "reject" }).or("null"),
	"userAgent?": "string | null",
	"timezone?": "string | null",
	"locale?": "string | null",
	"cpuThrottling?": "number | null",
	"network?": type("'slow3g' | 'fast3g' | null").or({
		download: "number",
		upload: "number",
		latency: "number",
		"+": "reject",
	}),
	"+": "reject",
});

/**
 * Check `tab.emulate()` options: unknown keys (`deviceScaleFactor`, `isMobile`, `media`) and wrong types fail, naming
 * the keys it takes. `reducedMotion` also takes the CSS values `"reduce"`/`"no-preference"`.
 */
export function validateEmulateOptions(options: unknown): BrowserEmulateOptions {
	const parsed = emulateOptionsSchema(options ?? {});
	if (parsed instanceof type.errors) {
		throw new ToolError(
			`tab.emulate() received invalid options: ${parsed.summary}. It takes viewport ({width, height, scale?, isMobile?, hasTouch?}), device, geolocation, offline, colorScheme, reducedMotion, media, headers, credentials, userAgent, timezone, locale, cpuThrottling, network.`,
		);
	}
	const { reducedMotion, ...rest } = parsed;
	const result: BrowserEmulateOptions = rest;
	if (reducedMotion !== undefined) result.reducedMotion = reducedMotion === true || reducedMotion === "reduce";
	return result;
}

type KnownDeviceMap = Readonly<Record<string, Device>>;
type KnownNetworkMap = Readonly<Record<string, NetworkConditions>>;

const hasOwn = <K extends keyof BrowserEmulateOptions>(
	value: BrowserEmulateOptions,
	key: K,
): value is BrowserEmulateOptions & Required<Pick<BrowserEmulateOptions, K>> =>
	Object.prototype.hasOwnProperty.call(value, key);

function copyOptions(options: BrowserEmulateOptions): BrowserEmulateOptions {
	return structuredClone(options);
}

function pageOrigin(page: Page): string | null {
	try {
		const origin = new URL(page.url()).origin;
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}

/** Apply a page-scoped user-agent override that remains active across navigations. */
export async function applyUserAgentOverride(page: Page, userAgent: string): Promise<void> {
	await page.setUserAgent(userAgent);
}

/** Owns persistent runtime emulation and clipboard state for one Puppeteer page. */
export class BrowserEmulationController {
	readonly #page: Page;
	readonly #devices: KnownDeviceMap;
	readonly #networkConditions: KnownNetworkMap;
	readonly #baseUserAgent: string;
	readonly #state: BrowserEmulateOptions = {};
	readonly #permissionsByOrigin = new Map<string, Set<Permission>>();
	#clipboardShim: string | undefined;
	/** The shim holds text the page clipboard never received (its write was refused). */
	#shimOnly = false;
	readonly #navigationHandler: (frame: Frame) => void;

	constructor(page: Page, devices: KnownDeviceMap, networkConditions: KnownNetworkMap, baseUserAgent: string) {
		this.#page = page;
		this.#devices = devices;
		this.#networkConditions = networkConditions;
		this.#baseUserAgent = baseUserAgent;
		this.#navigationHandler = frame => {
			if (frame !== this.#page.mainFrame()) return;
			if (this.#state.geolocation) void this.#grantPermissions(["geolocation"]).catch(() => undefined);
		};
		page.on("framenavigated", this.#navigationHandler);
	}

	/** Return all Puppeteer known-device names in stable order. */
	devices(): string[] {
		return Object.keys(this.#devices).sort();
	}

	/** Merge supplied overrides, apply the effective state, and return a detached state snapshot. */
	async emulate(options: unknown = {}): Promise<BrowserEmulateOptions> {
		Object.assign(this.#state, validateEmulateOptions(options));
		await this.reapply();
		return copyOptions(this.#state);
	}

	/** Re-apply every active override after a browser lifecycle resume. */
	async reapply(): Promise<void> {
		const state = this.#state;
		if (hasOwn(state, "device")) {
			const device = this.#devices[state.device];
			if (!device)
				throw new ToolError(`Unknown Puppeteer device ${JSON.stringify(state.device)}. Use tab.devices().`);
			await this.#page.emulate(device);
		}
		if (hasOwn(state, "viewport")) {
			await applyViewport(this.#page, {
				width: state.viewport.width,
				height: state.viewport.height,
				deviceScaleFactor: state.viewport.scale,
				isMobile: state.viewport.isMobile,
				hasTouch: state.viewport.hasTouch,
			});
		}
		if (hasOwn(state, "userAgent")) {
			if (state.userAgent !== null) await applyUserAgentOverride(this.#page, state.userAgent);
			else if (!hasOwn(state, "device")) await applyUserAgentOverride(this.#page, this.#baseUserAgent);
		}
		if (hasOwn(state, "geolocation")) {
			if (state.geolocation) {
				await this.#grantPermissions(["geolocation"]);
				await this.#page.setGeolocation(state.geolocation);
			} else {
				const session = await this.#page.createCDPSession();
				try {
					await session.send("Emulation.clearGeolocationOverride");
				} finally {
					await session.detach().catch(() => undefined);
				}
			}
		}
		if (hasOwn(state, "network")) {
			const conditions = this.#resolveNetworkConditions(state.network);
			await this.#page.emulateNetworkConditions(conditions);
		}
		if (hasOwn(state, "offline")) await this.#page.setOfflineMode(state.offline);
		if (hasOwn(state, "colorScheme") || hasOwn(state, "reducedMotion")) {
			const features: Array<{ name: string; value: string }> = [];
			if (hasOwn(state, "colorScheme")) {
				features.push({ name: "prefers-color-scheme", value: state.colorScheme });
			}
			if (hasOwn(state, "reducedMotion")) {
				features.push({ name: "prefers-reduced-motion", value: state.reducedMotion ? "reduce" : "no-preference" });
			}
			await this.#page.emulateMediaFeatures(features);
		}
		if (hasOwn(state, "media")) await this.#page.emulateMediaType(state.media ?? undefined);
		if (hasOwn(state, "headers")) await this.#page.setExtraHTTPHeaders(state.headers ?? {});
		if (hasOwn(state, "credentials")) await this.#page.authenticate(state.credentials);
		if (hasOwn(state, "timezone")) await this.#page.emulateTimezone(state.timezone ?? undefined);
		if (hasOwn(state, "locale")) await this.#page.emulateLocale(state.locale ?? undefined);
		if (hasOwn(state, "cpuThrottling")) await this.#page.emulateCPUThrottling(state.cpuThrottling);
	}

	/** Read text through the page clipboard, falling back only to a prior shim write. */
	async clipboardRead(): Promise<ClipboardReadResult> {
		try {
			await this.#grantPermissions(["clipboard-read", "clipboard-write"]);
			const text = await this.#page.evaluate(() => {
				const clipboard = (globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } })
					.navigator.clipboard;
				return clipboard.readText();
			});
			if (this.#clipboardShim !== undefined && text !== this.#clipboardShim) {
				return { text: this.#clipboardShim, source: "shim" };
			}
			return { text, source: "page" };
		} catch (error) {
			if (this.#clipboardShim !== undefined) return { text: this.#clipboardShim, source: "shim" };
			throw new ToolError("The page clipboard is unavailable and no shim value has been written", { cause: error });
		}
	}

	/** Write clipboard text through the page, retaining a worker shim only when Chromium blocks it. */
	async clipboardWrite(text: string): Promise<ClipboardActionResult> {
		try {
			await this.#grantPermissions(["clipboard-read", "clipboard-write"]);
			await this.#page.evaluate(value => {
				const clipboard = (
					globalThis as unknown as { navigator: { clipboard: { writeText(text: string): Promise<void> } } }
				).navigator.clipboard;
				return clipboard.writeText(value);
			}, text);
			this.#clipboardShim = text;
			this.#shimOnly = false;
			return { source: "page" };
		} catch {
			this.#clipboardShim = text;
			this.#shimOnly = true;
			return { source: "shim" };
		}
	}

	/** Copy the page's current selection using the platform keyboard shortcut. */
	async clipboardCopy(signal?: AbortSignal): Promise<ClipboardActionResult> {
		this.#clipboardShim = undefined;
		this.#shimOnly = false;
		// The copy shortcut is trusted input and needs no permission; the grant only helps page script read it back.
		await untilAborted(signal, () => this.#grantPermissionsBestEffort(["clipboard-read", "clipboard-write"]));
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await pressKey(this.#page, `${modifier}+c`, undefined, signal);
		return { source: "page" };
	}

	/** Paste the page clipboard into the focused control using the platform keyboard shortcut. */
	async clipboardPaste(signal?: AbortSignal): Promise<ClipboardActionResult> {
		if (this.#shimOnly && this.#clipboardShim !== undefined) {
			// The page clipboard never got the shim's text: type it in as one insertion, as a paste would land.
			const text = this.#clipboardShim;
			await untilAborted(signal, () => this.#page.keyboard.sendCharacter(text));
			return { source: "shim" };
		}
		await untilAborted(signal, () => this.#grantPermissionsBestEffort(["clipboard-read", "clipboard-write"]));
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await pressKey(this.#page, `${modifier}+v`, undefined, signal);
		return { source: "page" };
	}

	/** Remove page listeners owned by this controller. */
	dispose(): void {
		this.#page.off("framenavigated", this.#navigationHandler);
	}

	#resolveNetworkConditions(value: BrowserEmulateOptions["network"]): NetworkConditions | null {
		if (value === null || value === undefined) return null;
		if (typeof value !== "string") return { ...value };
		if (value !== "slow3g" && value !== "fast3g") {
			throw new ToolError(`Unknown network preset ${JSON.stringify(value)}. Expected "slow3g" or "fast3g".`);
		}
		const key = value === "slow3g" ? "Slow 3G" : "Fast 3G";
		const conditions = this.#networkConditions[key];
		if (!conditions) throw new ToolError(`Puppeteer network preset ${JSON.stringify(key)} is unavailable`);
		return conditions;
	}

	/**
	 * Grant where the browser allows it. The omp relay's extension debugger has no `Browser.grantPermissions`, and
	 * trusted copy/paste shortcuts work without the grant.
	 */
	async #grantPermissionsBestEffort(permissions: Permission[]): Promise<void> {
		try {
			await this.#grantPermissions(permissions);
		} catch {
			// Ungranted: the shortcut still reaches the page as trusted input.
		}
	}

	async #grantPermissions(permissions: Permission[]): Promise<void> {
		const origin = pageOrigin(this.#page);
		if (!origin) return;
		const granted = this.#permissionsByOrigin.get(origin) ?? new Set<Permission>();
		for (const permission of permissions) granted.add(permission);
		this.#permissionsByOrigin.set(origin, granted);
		await this.#page.browserContext().overridePermissions(origin, [...granted]);
	}
}
