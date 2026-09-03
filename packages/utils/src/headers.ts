/** Behavior-compatible reimplementation of header-generator's used surface. */

/** A browser family supported by the curated header profiles. */
export type BrowserName = "chrome" | "firefox" | "safari";

/** A desktop operating system supported by the curated header profiles. */
export type OperatingSystem = "windows" | "macos" | "linux";

/** Constructor and per-call constraints for header generation. */
export interface HeaderGeneratorOptions {
	/** Browser families eligible for a draw. */
	browsers: BrowserName[];
	/** Browser selection query; the supported `last 3 versions` query uses the curated versions. */
	browserListQuery: string;
	/** Desktop operating systems eligible for a draw. */
	operatingSystems: OperatingSystem[];
	/** Device classes eligible for a draw. */
	devices: "desktop"[];
	/** Ordered locales for the Accept-Language value. */
	locales: string[];
	/** HTTP protocol generation mode. */
	httpVersion: "1" | "2";
	/** Whether impossible constraints throw instead of relaxing to a coherent profile. */
	strict: boolean;
	/** Random source returning a value in the range from zero (inclusive) to one (exclusive). */
	rng: () => number;
}

/** A generated HTTP request header map. */
export type Headers = Record<string, string>;

type ResolvedOptions = Omit<HeaderGeneratorOptions, "rng">;

type BrowserProfile = {
	browser: BrowserName;
	operatingSystem: OperatingSystem;
	version: number;
	userAgent: string;
};

const DEFAULT_OPTIONS: ResolvedOptions = {
	browsers: ["chrome", "firefox", "safari"],
	browserListQuery: "",
	operatingSystems: ["windows", "macos", "linux"],
	devices: ["desktop"],
	locales: ["en-US", "en"],
	httpVersion: "2",
	strict: false,
};

const VERSIONS: Readonly<Record<BrowserName, readonly number[]>> = {
	chrome: [149, 150, 151],
	firefox: [147, 148, 149],
	safari: [26, 26.1, 26.2],
};

function pick<T>(values: readonly T[], rng: () => number): T {
	const random = rng();
	const index = Math.min(values.length - 1, Math.max(0, Math.floor(random * values.length)));
	const value = values[index];
	if (value === undefined) throw new Error("Cannot choose from an empty header profile list");
	return value;
}

function formatLocales(locales: readonly string[]): string {
	return locales
		.slice(0, 10)
		.map((locale, index) => {
			if (index === 0) return locale;
			const quality = Math.max(0.1, 1 - index / 10).toFixed(1);
			return `${locale};q=${quality}`;
		})
		.join(",");
}

function makeUserAgent(browser: BrowserName, operatingSystem: OperatingSystem, version: number): string {
	if (browser === "safari") {
		return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version.toFixed(1)} Safari/605.1.15`;
	}

	const platform =
		operatingSystem === "windows"
			? "Windows NT 10.0; Win64; x64"
			: operatingSystem === "macos"
				? "Macintosh; Intel Mac OS X 10_15_7"
				: "X11; Linux x86_64";
	if (browser === "firefox") {
		return `Mozilla/5.0 (${platform}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
	}
	return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
}

function makeProfile(options: ResolvedOptions, rng: () => number): BrowserProfile {
	const candidates: Array<{ browser: BrowserName; operatingSystem: OperatingSystem }> = [];
	for (const browser of options.browsers) {
		for (const operatingSystem of options.operatingSystems) {
			if (browser === "safari" && operatingSystem !== "macos") continue;
			candidates.push({ browser, operatingSystem });
		}
	}

	if (candidates.length === 0) {
		if (options.strict) throw new Error("No coherent browser profile matches the requested options");
		candidates.push({ browser: "chrome", operatingSystem: "windows" });
	}

	const candidate = pick(candidates, rng);
	const version = pick(VERSIONS[candidate.browser], rng);
	return {
		...candidate,
		version,
		userAgent: makeUserAgent(candidate.browser, candidate.operatingSystem, version),
	};
}

/** Generates coherent modern desktop browser navigation headers. */
export class HeaderGenerator {
	#options: ResolvedOptions;
	#rng: () => number;

	/** Creates a generator with reusable constraints and an optionally injectable RNG. */
	constructor(options: Partial<HeaderGeneratorOptions> = {}) {
		this.#rng = options.rng ?? Math.random;
		this.#options = { ...DEFAULT_OPTIONS, ...options };
		if (this.#options.devices.some(device => device !== "desktop") && this.#options.strict) {
			throw new Error("Only desktop browser profiles are available");
		}
		if (this.#options.locales.length === 0 && this.#options.strict) {
			throw new Error("At least one locale is required");
		}
	}

	/** Generates one header set, applying per-call constraints and request overrides. */
	getHeaders(options: Partial<HeaderGeneratorOptions> = {}, overrides: Headers = {}): Headers {
		const resolved = { ...this.#options, ...options };
		const rng = options.rng ?? this.#rng;
		const profile = makeProfile(resolved, rng);
		const headers: Headers = {
			accept:
				profile.browser === "chrome"
					? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
					: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"user-agent": profile.userAgent,
			"accept-encoding": profile.browser === "safari" ? "gzip, deflate, br" : "gzip, deflate, br, zstd",
			"accept-language": formatLocales(resolved.locales.length > 0 ? resolved.locales : DEFAULT_OPTIONS.locales),
			"upgrade-insecure-requests": "1",
			"sec-fetch-dest": "document",
			"sec-fetch-mode": "navigate",
			"sec-fetch-site": "none",
			"sec-fetch-user": "?1",
		};

		if (profile.browser === "chrome") {
			headers["sec-ch-ua"] =
				`"Google Chrome";v="${profile.version}", "Chromium";v="${profile.version}", "Not_A Brand";v="24"`;
			headers["sec-ch-ua-mobile"] = "?0";
			headers["sec-ch-ua-platform"] =
				profile.operatingSystem === "windows"
					? '"Windows"'
					: profile.operatingSystem === "macos"
						? '"macOS"'
						: '"Linux"';
		}

		return { ...headers, ...overrides };
	}
}
