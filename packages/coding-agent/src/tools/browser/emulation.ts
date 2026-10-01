import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Device, Frame, NetworkConditions, Page, Permission } from "puppeteer-core";
import { applyViewport } from "./launch";

/** Viewport dimensions accepted by runtime emulation. */
export interface EmulationViewport {
	/** Viewport width in CSS pixels. */
	width: number;
	/** Viewport height in CSS pixels. */
	height: number;
	/** Device scale factor. */
	scale?: number;
}

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
	/** Toggle reduced-motion preference. */
	reducedMotion?: boolean;
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
	async emulate(options: BrowserEmulateOptions = {}): Promise<BrowserEmulateOptions> {
		Object.assign(this.#state, copyOptions(options));
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
			return { source: "page" };
		} catch {
			this.#clipboardShim = text;
			return { source: "shim" };
		}
	}

	/** Copy the page's current selection using the platform keyboard shortcut. */
	async clipboardCopy(): Promise<ClipboardActionResult> {
		this.#clipboardShim = undefined;
		await this.#grantPermissions(["clipboard-read", "clipboard-write"]);
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await this.#page.keyboard.down(modifier);
		try {
			await this.#page.keyboard.press("c");
		} finally {
			await this.#page.keyboard.up(modifier);
		}
		return { source: "page" };
	}

	/** Paste the page clipboard into the focused control using the platform keyboard shortcut. */
	async clipboardPaste(): Promise<ClipboardActionResult> {
		await this.#grantPermissions(["clipboard-read", "clipboard-write"]);
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await this.#page.keyboard.down(modifier);
		try {
			await this.#page.keyboard.press("v");
		} finally {
			await this.#page.keyboard.up(modifier);
		}
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

	async #grantPermissions(permissions: Permission[]): Promise<void> {
		const origin = pageOrigin(this.#page);
		if (!origin) return;
		const granted = this.#permissionsByOrigin.get(origin) ?? new Set<Permission>();
		for (const permission of permissions) granted.add(permission);
		this.#permissionsByOrigin.set(origin, granted);
		await this.#page.browserContext().overridePermissions(origin, [...granted]);
	}
}
