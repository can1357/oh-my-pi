import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isDakeraConfigured, loadDakeraConfig } from "@oh-my-pi/pi-coding-agent/dakera/config";

// `loadDakeraConfig` takes the env bag as an argument, so precedence is proven
// without touching `process.env`.
const configFor = (settingsValue: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) =>
	loadDakeraConfig(Settings.isolated({ "dakera.apiUrl": "http://server.local", ...settingsValue }), env);

describe("loadDakeraConfig", () => {
	it("lets DAKERA_* win over persisted settings", () => {
		const config = configFor(
			{ "dakera.apiUrl": "http://from-settings", "dakera.recallTopK": 3, "dakera.autoRetain": true },
			{ DAKERA_API_URL: "http://from-env", DAKERA_RECALL_TOP_K: "12", DAKERA_AUTO_RETAIN: "false" },
		);
		expect(config.apiUrl).toBe("http://from-env");
		expect(config.recallTopK).toBe(12);
		expect(config.autoRetain).toBe(false);
	});

	// A deployment exports one variable and the server, the MCP surface and omp
	// all agree; the token-shaped name still wins when both are present.
	it("accepts DAKERA_API_KEY when DAKERA_API_TOKEN is unset", () => {
		expect(configFor({}, { DAKERA_API_KEY: "dk_key" }).apiToken).toBe("dk_key");
		expect(configFor({}, { DAKERA_API_KEY: "dk_key", DAKERA_API_TOKEN: "dk_token" }).apiToken).toBe("dk_token");
	});

	// CI shells routinely export DAKERA_API_URL="" — that must fall back to the
	// persisted value rather than clear the endpoint.
	it("treats a blank env value as unset", () => {
		expect(configFor({}, { DAKERA_API_URL: "   " }).apiUrl).toBe("http://server.local");
		expect(configFor({}, { DAKERA_RECALL_TOP_K: "abc" }).recallTopK).toBe(8);
	});

	// `Number("")` is 0 and an empty boolean parse is false — an exported-but-
	// empty variable must not pin numeric settings to zero or booleans to false;
	// it is unset, exactly like a blank string.
	it("treats an empty numeric or boolean env value as unset", () => {
		expect(configFor({ "dakera.recallTopK": 3 }, { DAKERA_RECALL_TOP_K: "" }).recallTopK).toBe(3);
		expect(configFor({ "dakera.recallTopK": 3 }, { DAKERA_RECALL_TOP_K: "  " }).recallTopK).toBe(3);
		expect(configFor({ "dakera.autoRetain": true }, { DAKERA_AUTO_RETAIN: "" }).autoRetain).toBe(true);
	});
	// An explicit empty string in settings is the documented way to point the
	// backend at nothing; the localhost default must not resurrect it.
	it("marks an explicitly blank apiUrl as unconfigured", () => {
		expect(isDakeraConfigured(configFor({ "dakera.apiUrl": "" }))).toBe(false);
	});

	// The settings UI cannot persist an empty string (clearing a field unsets
	// it and the default resurfaces), so `none` is the persisted off switch.
	it("maps the `none` sentinel to a disabled globalTag", () => {
		expect(configFor({ "dakera.globalTag": "none" }).globalTag).toBe("");
		expect(configFor({ "dakera.globalTag": "NONE" }).globalTag).toBe("");
		expect(configFor({}, { DAKERA_GLOBAL_TAG: "none" }).globalTag).toBe("");
		expect(configFor({ "dakera.globalTag": "team:common" }).globalTag).toBe("team:common");
	});

	// The shared tier is opt-in: with nothing configured the recall filter is
	// strictly the project tag, and `global:shared` must not resurrect itself.
	it("defaults globalTag to disabled (empty)", () => {
		expect(configFor({}).globalTag).toBe("");
		expect(configFor({}, { DAKERA_GLOBAL_TAG: "global:shared" }).globalTag).toBe("global:shared");
	});

	it("marks a present apiUrl as configured", () => {
		expect(isDakeraConfigured(configFor())).toBe(true);
	});

	// `DAKERA_*` values bypass registry validation, so a typo'd mode must fall
	// back to the persisted setting instead of yielding an unknown scoping,
	// while a valid env mode still overrides the persisted one.
	it("ignores an invalid scoping or retainMode from the environment", () => {
		const persisted = { "dakera.scoping": "global", "dakera.retainMode": "last-turn" };
		const ignored = configFor(persisted, {
			DAKERA_SCOPING: "per-project-untagged",
			DAKERA_RETAIN_MODE: "half-session",
		});
		expect(ignored.scoping).toBe("global");
		expect(ignored.retainMode).toBe("last-turn");

		const overridden = configFor(persisted, {
			DAKERA_SCOPING: "per-project-tagged",
			DAKERA_RETAIN_MODE: "full-session",
		});
		expect(overridden.scoping).toBe("per-project-tagged");
		expect(overridden.retainMode).toBe("full-session");
	});

	it("keeps an explicit false for booleans instead of treating it as unset", () => {
		const config = configFor({ "dakera.autoRecall": false, "dakera.recallRerank": false });
		expect(config.autoRecall).toBe(false);
		expect(config.recallRerank).toBe(false);

		const envOn = configFor({ "dakera.autoRecall": false }, { DAKERA_AUTO_RECALL: "true" });
		expect(envOn.autoRecall).toBe(true);
	});
});
