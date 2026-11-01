import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { all, bindEffects, combine, effect, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { loadHandEditedSettings } from "../helpers/hand-edited-settings";
import { YAML } from "bun";

import {
	cfgProvidersMaxInFlightRequests,
	cfgTemperature,
	cfgTopK,
	cfgTopP,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgSteeringMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgEditFuzzyMatch, cfgEditModelVariants } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { cfgTaskAgentPrewalk, cfgTaskMaxConcurrency } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgEvalPy } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgSearxngBasicPassword, cfgSearxngEndpoint } from "@oh-my-pi/pi-coding-agent/web/settings";

const tick = () => Promise.resolve();

/** Runs `fn` with environment variables set (`undefined` unsets), restoring the previous values after. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const name in vars) {
		saved[name] = Bun.env[name];
		const value = vars[name];
		if (value === undefined) delete Bun.env[name];
		else Bun.env[name] = value;
	}
	try {
		fn();
	} finally {
		for (const name in saved) {
			const value = saved[name];
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
	}
}

describe("settings registry", () => {
	it("lets an override env beat every layer while a fallback env only replaces the default", () => {
		withEnv({ PI_EDIT_FUZZY: "0", SEARXNG_ENDPOINT: "https://env.example" }, () => {
			const configured = Settings.isolated({ "edit.fuzzyMatch": true, "searxng.endpoint": "https://cfg.example" });
			expect(cfgEditFuzzyMatch.get(configured)).toBe(false);
			expect(cfgEditFuzzyMatch.provenance(configured)).toBe("env");
			expect(cfgSearxngEndpoint.get(configured)).toBe("https://cfg.example");
			expect(cfgSearxngEndpoint.provenance(configured)).toBe("runtime");

			const bare = Settings.isolated();
			expect(cfgSearxngEndpoint.get(bare)).toBe("https://env.example");
			expect(cfgSearxngEndpoint.isConfigured(bare)).toBe(true);
		});
	});

	it("parses a boolean env var like parseFlag: empty is unset, unlisted text is false", () => {
		const configuredOff = Settings.isolated({ "eval.py": false });
		withEnv({ PI_PY: "" }, () => {
			expect(cfgEvalPy.get(configuredOff)).toBe(false);
			expect(cfgEvalPy.provenance(configuredOff)).toBe("runtime");
		});
		withEnv({ PI_PY: "y" }, () => expect(cfgEvalPy.get(configuredOff)).toBe(true));
		withEnv({ PI_PY: "disabled" }, () => {
			expect(cfgEvalPy.get(Settings.isolated())).toBe(false);
			expect(cfgEvalPy.provenance(Settings.isolated())).toBe("env");
		});
	});

	it("treats a configured null as unset for fallback env vars and provenance", () => {
		withEnv({ SEARXNG_BASIC_PASSWORD: "env-secret" }, () => {
			const cleared = Settings.isolated({ "searxng.basicPassword": null });
			expect(cfgSearxngBasicPassword.get(cleared)).toBe("env-secret");
			expect(cfgSearxngBasicPassword.provenance(cleared)).toBe("env");
		});
		withEnv({ SEARXNG_BASIC_PASSWORD: undefined }, () => {
			const cleared = Settings.isolated({ "searxng.basicPassword": null });
			expect(cfgSearxngBasicPassword.isConfigured(cleared)).toBe(false);
			expect(cfgSearxngBasicPassword.provenance(cleared)).toBe("default");
		});
	});

	it("lets a fallback env var apply over a configured value the setting rejects, with a warning", async () => {
		const dir = TempDir.createSync("@pi-settings-env-rejected-");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			// `searxng.endpoint` yields to its variable on a blank value; `searxng.basicPassword` only when unset.
			const settings = await loadHandEditedSettings(dir, {
				global: { searxng: { endpoint: 8080, basicPassword: 42 } },
			});
			withEnv({ SEARXNG_ENDPOINT: "https://env.example", SEARXNG_BASIC_PASSWORD: "env-secret" }, () => {
				expect(cfgSearxngEndpoint.get(settings)).toBe("https://env.example");
				expect(cfgSearxngBasicPassword.get(settings)).toBe("env-secret");
			});
			// A global value is read, not dropped at load, and its warning still names the file.
			const source = dir.join("agent", "config.yml");
			expect(warn).toHaveBeenCalledWith("Settings: ignoring invalid value", {
				setting: "searxng.endpoint",
				valueType: "number",
				valueLength: 4,
				expected: "a string",
				source,
			});
			// Every rejected value is metadata-only, credential or not.
			expect(warn).toHaveBeenCalledWith("Settings: ignoring invalid value", {
				setting: "searxng.basicPassword",
				valueType: "number",
				valueLength: 2,
				expected: "a string",
				source,
			});
		} finally {
			warn.mockRestore();
			dir.removeSync();
		}
	});

	it("never logs a rejected value, including nested tokens in an unmarked setting", async () => {
		const dir = TempDir.createSync("@pi-settings-rejected-value-");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const secret = "settings-registry-nested-token-9f2c";
		try {
			// Lists where records are expected, under a valid `--config` record that hides the project layer.
			await loadHandEditedSettings(dir, {
				project: {
					images: { urls: { credentials: [{ token: secret }] } },
					temperature: { apiToken: secret },
					steeringMode: secret,
				},
				overlays: [{ images: { urls: { credentials: {} } } }],
			});
			expect(warn).toHaveBeenCalledWith("Settings: ignoring invalid value", {
				setting: "images.urls.credentials",
				valueType: "array",
				valueLength: 1,
				expected: "a record",
				source: expect.stringMatching(/\.omp[\\/]config\.yml$/),
			});
			expect(warn).toHaveBeenCalledWith("Settings: ignoring invalid value", {
				setting: "temperature",
				valueType: "object",
				valueLength: 1,
				expected: "a number",
				source: expect.stringMatching(/\.omp[\\/]config\.yml$/),
			});
			expect(warn).toHaveBeenCalledWith("Settings: ignoring invalid value", {
				setting: "steeringMode",
				valueType: "string",
				valueLength: secret.length,
				expected: expect.stringContaining("one of "),
				source: expect.stringMatching(/\.omp[\\/]config\.yml$/),
			});
			expect(Bun.inspect(warn.mock.calls)).not.toContain(secret);
		} finally {
			warn.mockRestore();
			dir.removeSync();
		}
	});

	it("never puts a rejected value in a validation, write or parse error", () => {
		// A token pasted into the wrong key is the likeliest rejected value; a validator's error is logged
		// when a watched reload keeps the last good config, and `omp config set` prints a parse error.
		const secret = "sk-ant-api03-validation-canary-17600";
		const errors: string[] = [];
		const capture = (fn: () => unknown): void => {
			try {
				fn();
			} catch (error) {
				errors.push(String(error));
			}
		};
		capture(() => Settings.isolated({ "session.maxCost": secret }));
		capture(() => Settings.isolated({ "session.warnCost": { apiToken: secret } }));
		capture(() => Settings.isolated({ "task.agentSoftRequestBudget": { lead: secret } }));
		capture(() => Settings.isolated({ "task.perCallModelAllow": secret }));
		capture(() => Settings.isolated({ "task.perCallModelAllow": [{ token: secret }] }));
		capture(() => Settings.isolated({ temperature: secret }));
		for (const id of ["temperature", "compaction.enabled", "steeringMode", "task.agentPrewalk"]) {
			capture(() => lookup(id)?.parse(secret));
		}
		expect(errors).toHaveLength(10);
		expect(errors.join("\n")).not.toContain(secret);
		expect(errors).toContain(
			`Error: Invalid session.maxCost: expected a positive USD amount, got string (length ${secret.length}).`,
		);
	});

	it("keeps what a lower project file holds when a higher project file holds a rejected value", async () => {
		using dir = TempDir.createSync("@pi-settings-project-files-");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const agentDir = dir.join("agent");
			const cwd = dir.join("project");
			// The project's settings.json ranks below its config.yml.
			await Bun.write(
				path.join(cwd, ".omp", "settings.json"),
				JSON.stringify({ temperature: 0.4, tools: { approval: { bash: "deny" } } }),
			);
			await Bun.write(
				path.join(cwd, ".omp", "config.yml"),
				YAML.stringify({ temperature: "hot", tools: { approval: "deny-bash" } }),
			);
			const settings = await Settings.loadReadOnly({ agentDir, cwd });
			expect(lookup("tools.approval")?.get(settings)).toEqual({ bash: "deny" });
			expect(cfgTemperature.get(settings)).toBe(0.4);
			expect(
				settings
					.ignoredValues()
					.map(ignored => ignored.setting.id)
					.sort(),
			).toEqual(["temperature", "tools.approval"]);
		} finally {
			warn.mockRestore();
		}
	});

	it("shows an overlay a rejection its parent learns on a later reload", async () => {
		using dir = TempDir.createSync("@pi-settings-rejected-overlay-");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const parent = await loadHandEditedSettings(dir, { global: {} }, { reloadable: true });
			const child = parent.overlay();
			expect(child.ignoredValues()).toEqual([]);
			await Bun.write(dir.join("project", ".omp", "config.yml"), YAML.stringify({ temperature: "hot" }));
			await parent.reloadFromDisk();
			expect(child.ignoredValues().map(ignored => ignored.setting.id)).toEqual(["temperature"]);
		} finally {
			warn.mockRestore();
		}
	});

	it("keeps the record of a rejected value when a reload fails before its layers are committed", async () => {
		using dir = TempDir.createSync("@pi-settings-rejected-partial-reload-");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const settings = await loadHandEditedSettings(
				dir,
				{ overlays: [{ temperature: "hot" }, { topK: 5 }] },
				{ reloadable: true },
			);
			const ignored = () => settings.ignoredValues().map(({ setting, source }) => [setting.id, source]);
			expect(ignored()).toEqual([["temperature", dir.join("overlay-0.yml")]]);
			// The first file is fixed and the second no longer parses: nothing is adopted.
			await Bun.write(dir.join("overlay-0.yml"), YAML.stringify({ temperature: 0.3 }));
			await Bun.write(dir.join("overlay-1.yml"), "topK: [unterminated\n");
			await expect(settings.reloadFromDisk()).rejects.toThrow();
			expect(cfgTemperature.get(settings)).toBe(cfgTemperature.default);
			expect(ignored()).toEqual([["temperature", dir.join("overlay-0.yml")]]);
		} finally {
			warn.mockRestore();
		}
	});

	it("reads a value the setting rejects as unset where it is written: value, presence and provenance agree", async () => {
		const dir = TempDir.createSync("@pi-settings-rejected-layer-");
		const aloneDir = TempDir.createSync("@pi-settings-rejected-alone-");
		const validatedDir = TempDir.createSync("@pi-settings-rejected-validated-");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const underGlobal = await loadHandEditedSettings(dir, {
				global: { temperature: 0.2, task: { agentPrewalk: { scout: "anthropic/claude-haiku-4-5" } } },
				project: { temperature: "hot", task: { agentPrewalk: "fast" } },
				overlays: [{ task: { agentPrewalk: { plan: "anthropic/claude-opus-4-8" } } }],
			});
			expect(cfgTemperature.get(underGlobal)).toBe(0.2);
			expect(cfgTemperature.isConfigured(underGlobal)).toBe(true);
			expect(cfgTemperature.provenance(underGlobal)).toBe("global");
			// The malformed project record does not replace the global entries the --config record merges over.
			expect(cfgTaskAgentPrewalk.get(underGlobal)).toEqual({
				plan: "anthropic/claude-opus-4-8",
				scout: "anthropic/claude-haiku-4-5",
			});
			expect(warn).toHaveBeenCalledWith("Settings: ignoring invalid value", {
				setting: "temperature",
				valueType: "string",
				valueLength: 3,
				expected: "a number",
				source: expect.stringMatching(/\.omp[\\/]config\.yml$/),
			});
			// The project layer as written still shows it, so a host editing that file does not lose it.
			expect(underGlobal.getProjectSettings()).toMatchObject({ temperature: "hot" });

			const alone = await loadHandEditedSettings(aloneDir, { overlays: [{ temperature: "hot" }] });
			expect(cfgTemperature.get(alone)).toBe(cfgTemperature.default);
			expect(cfgTemperature.isConfigured(alone)).toBe(false);
			expect(cfgTemperature.provenance(alone)).toBe("default");

			// A setting with `validate` keeps the value for its check and reads it as unset, never the
			// lower value that check did not see.
			const validated = await loadHandEditedSettings(validatedDir, {
				global: { providers: { maxInFlightRequests: { openai: -1 } } },
				overlays: [{ providers: { maxInFlightRequests: "lots" } }],
			});
			expect(cfgProvidersMaxInFlightRequests.get(validated)).toEqual({});
			expect(cfgProvidersMaxInFlightRequests.isConfigured(validated)).toBe(false);
		} finally {
			warn.mockRestore();
			dir.removeSync();
			aloneDir.removeSync();
			validatedDir.removeSync();
		}
	});

	it("warns once per file about a value it holds, and again only after the file fixes and breaks it", async () => {
		const dir = TempDir.createSync("@pi-settings-rejected-warn-once-");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const sources = () =>
			warn.mock.calls
				.filter(([message]) => message === "Settings: ignoring invalid value")
				.map(([, context]) =>
					context && typeof context === "object" && "source" in context ? context.source : undefined,
				);
		try {
			const settings = await loadHandEditedSettings(
				dir,
				{ global: { temperature: 0.2 }, overlays: [{ temperature: "hot" }, { temperature: "hot" }] },
				{ reloadable: true },
			);
			const [first, second] = [dir.join("overlay-0.yml"), dir.join("overlay-1.yml")];
			expect(sources()).toEqual([first, second]);

			expect(cfgTemperature.get(settings)).toBe(0.2);
			await settings.reloadFromDisk();
			await settings.reloadFromDisk();
			expect(sources()).toEqual([first, second]);

			await Bun.write(second, YAML.stringify({ temperature: 0.4 }));
			await settings.reloadFromDisk();
			await Bun.write(second, YAML.stringify({ temperature: "hot" }));
			await settings.reloadFromDisk();
			expect(sources()).toEqual([first, second, second]);
		} finally {
			warn.mockRestore();
			dir.removeSync();
		}
	});

	it("rejects writes whose value does not fit the setting's type", () => {
		const settings = Settings.isolated({ temperature: 0.2 });
		const temperature = lookup("temperature");
		expect(() => temperature?.set(settings, "hot")).toThrow("Invalid value for temperature");
		expect(() => temperature?.override(settings, Number.NaN)).toThrow("Invalid value for temperature");
		expect(() => lookup("steeringMode")?.override(settings, "sometimes")).toThrow("Invalid value for steeringMode");
		expect(cfgTemperature.get(settings)).toBe(0.2);
		expect(cfgTemperature.provenance(settings)).toBe("runtime");
	});

	it("recomputes a derivation only when one of its inputs changes", () => {
		const settings = Settings.isolated();
		let computations = 0;
		const sampling = combine({ temperature: cfgTemperature, topP: cfgTopP }, values => {
			computations++;
			return { ...values };
		});

		const first = sampling.get(settings);
		expect(sampling.get(settings)).toBe(first);
		cfgTopK.override(settings, 7);
		expect(sampling.get(settings)).toBe(first);
		expect(computations).toBe(1);

		cfgTemperature.override(settings, 0.3);
		expect(sampling.get(settings)).toEqual({ temperature: 0.3, topP: first.topP });
		expect(computations).toBe(2);
	});

	it("coalesces listener notifications per tick and skips no-op changes", async () => {
		const settings = Settings.isolated();
		const seen: [number, number][] = [];
		cfgTemperature.listen(settings, (next, previous) => {
			seen.push([next, previous]);
		});

		const initial = cfgTemperature.get(settings);
		cfgTemperature.override(settings, 0.4);
		cfgTemperature.override(settings, 0.6);
		await tick();
		expect(seen).toEqual([[0.6, initial]]);

		cfgTemperature.override(settings, 0.6);
		cfgTopP.override(settings, 0.5);
		await tick();
		expect(seen).toHaveLength(1);
	});

	it("drops listeners with the owning scope", async () => {
		const settings = Settings.isolated();
		const disposers: (() => void)[] = [];
		const scope = { settings, addDisposer: (dispose: () => void) => disposers.push(dispose) };
		let calls = 0;
		cfgTemperature.listen(scope, () => {
			calls++;
		});

		for (const dispose of disposers) dispose();
		cfgTemperature.override(settings, 0.9);
		await tick();
		expect(calls).toBe(0);
	});

	it("reads an overlay through to its parent while keeping overlay writes local", async () => {
		const parent = Settings.isolated({ temperature: 0.2 });
		const child = parent.overlay({ topP: 0.5 });
		const childTemperatures: number[] = [];
		cfgTemperature.listen(child, next => {
			childTemperatures.push(next);
		});

		cfgTemperature.override(parent, 0.7);
		await tick();
		expect(cfgTemperature.get(child)).toBe(0.7);
		expect(childTemperatures).toEqual([0.7]);

		cfgTemperature.set(child, 0.1);
		expect(cfgTemperature.get(child)).toBe(0.1);
		expect(cfgTemperature.get(parent)).toBe(0.7);

		// The child's own value now pins temperature: parent edits no longer reach it.
		cfgTemperature.override(parent, 0.8);
		await tick();
		expect(cfgTemperature.get(child)).toBe(0.1);
		expect(childTemperatures).toEqual([0.7, 0.1]);
		expect(cfgTopP.get(parent)).not.toBe(0.5);
	});

	it("keeps host overlays authoritative and delegates only subagent-derived views", () => {
		const operator = Settings.isolated();
		const host = operator.overlay({ modelRoles: { review: "mock/target" } });
		const child = host.overlay({ modelRoles: { advisor: "mock/other" } }, { derived: true });
		const grandchild = child.overlay({}, { derived: true });
		expect(operator.grantAuthority().getModelRole("review")).toBeUndefined();
		expect(host.grantAuthority().getModelRole("review")).toBe("mock/target");
		expect(child.grantAuthority()).toBe(host.grantAuthority());
		expect(grandchild.grantAuthority()).toBe(host.grantAuthority());
		expect(child.grantAuthority().getModelRole("advisor")).toBeUndefined();
	});

	it("rebuilds a host overlay's grant authority after its parent changes", () => {
		const operator = Settings.isolated({ modelRoles: { review: "mock/target" } });
		const host = operator.overlay();
		expect(host.grantAuthority().getModelRole("review")).toBe("mock/target");
		operator.setModelRole("review", "mock/other");
		expect(host.grantAuthority().getModelRole("review")).toBe("mock/other");
	});

	it.each([false, true])("preserves derived=%s when restoring overlay layers", derived => {
		const parent = Settings.isolated();
		const child = parent.overlay({ modelRoles: { review: "mock/target" } }, { derived });
		const restored = parent.restoreOverlay(child.overlayLayers());
		expect(restored.getModelRole("review")).toBe("mock/target");
		expect(restored.grantAuthority().getModelRole("review")).toBe(derived ? undefined : "mock/target");
	});

	it("preserves a derived view's host authority when cloning for cwd", async () => {
		const operator = Settings.isolated();
		const host = operator.overlay({ modelRoles: { review: "mock/target" } });
		const child = host.overlay({ modelRoles: { advisor: "mock/other" } }, { derived: true });
		const clone = await child.cloneForCwd(host.getCwd());
		expect(clone.grantAuthority().getModelRole("review")).toBe("mock/target");
		expect(clone.grantAuthority().getModelRole("advisor")).toBeUndefined();
		const hostClone = await host.cloneForCwd(host.getCwd());
		expect(hostClone.grantAuthority().getModelRole("review")).toBe("mock/target");
	});

	it("delivers every synchronous parent write to an overlay", async () => {
		const parent = Settings.isolated();
		const child = parent.overlay();
		const grandchild = child.overlay();
		const seen: string[] = [];
		cfgTemperature.listen(child, value => {
			seen.push(`temperature=${value}`);
		});
		cfgTopP.listen(child, value => {
			seen.push(`topP=${value}`);
		});

		cfgTopP.listen(grandchild, value => {
			seen.push(`grandchild topP=${value}`);
		});
		cfgSteeringMode.listen(grandchild, value => {
			seen.push(`grandchild steeringMode=${value}`);
		});

		cfgTemperature.override(parent, 0.7);
		cfgTopP.override(parent, 0.33);
		cfgSteeringMode.override(parent, "all");
		expect(cfgTopP.get(child)).toBe(0.33);
		expect(cfgSteeringMode.get(child)).toBe("all");
		expect(cfgSteeringMode.get(grandchild)).toBe("all");
		await tick();
		expect(seen.sort()).toEqual([
			"grandchild steeringMode=all",
			"grandchild topP=0.33",
			"temperature=0.7",
			"topP=0.33",
		]);
	});

	it("treats a reordered record as a change, since record order carries precedence", async () => {
		const settings = Settings.isolated({ "edit.modelVariants": { claude: "patch", sonnet: "replace" } });
		const seen: string[][] = [];
		cfgEditModelVariants.listen(settings, value => {
			seen.push(Object.keys(value));
		});

		cfgEditModelVariants.override(settings, { sonnet: "replace", claude: "patch" });
		expect(Object.keys(cfgEditModelVariants.get(settings))).toEqual(["sonnet", "claude"]);
		await tick();
		expect(seen).toEqual([["sonnet", "claude"]]);
	});

	it("releases a soft-pinned default on a global write or unset of that setting", () => {
		const written = Settings.isolated();
		cfgTaskMaxConcurrency.pinDefault(written);
		expect(cfgTaskMaxConcurrency.provenance(written)).toBe("runtime");
		cfgTaskMaxConcurrency.set(written, 9);
		expect(cfgTaskMaxConcurrency.get(written)).toBe(9);
		expect(cfgTaskMaxConcurrency.provenance(written)).toBe("global");

		const unset = Settings.isolated();
		cfgTaskMaxConcurrency.pinDefault(unset);
		cfgTaskMaxConcurrency.unset(unset);
		expect(cfgTaskMaxConcurrency.provenance(unset)).toBe("default");

		// An explicit runtime override is not a soft pin: a global write stays beneath it.
		const overridden = Settings.isolated();
		cfgTaskMaxConcurrency.override(overridden, 4);
		cfgTaskMaxConcurrency.set(overridden, 9);
		expect(cfgTaskMaxConcurrency.get(overridden)).toBe(4);
	});

	it("warns once per instance about an invalid configured value, unaffected by other instances", async () => {
		const tempDir = TempDir.createSync("@pi-settings-warn-");
		try {
			const agentDir = tempDir.join("agent");
			const cwd = tempDir.join("project");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.mkdirSync(cwd, { recursive: true });
			await Bun.write(
				path.join(agentDir, "config.yml"),
				YAML.stringify({ temperature: "hot", statusLine: { leftSegments: ["modle"] } }),
			);
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const warnings = (prefix: string) => warn.mock.calls.filter(([message]) => String(message).startsWith(prefix));
			const invalid = () => warnings("Settings: ignoring invalid value");
			const unknownItems = () => warnings("Settings: unknown status line segment");

			const settings = await Settings.loadReadOnly({ cwd, agentDir });
			expect(unknownItems()).toHaveLength(1);
			expect(cfgTemperature.get(settings)).toBe(cfgTemperature.default);
			expect(invalid()).toHaveLength(1);

			// Instances holding valid values never re-arm another instance's warnings.
			const unrelated = Settings.isolated();
			cfgTemperature.get(unrelated);
			await unrelated.cloneForCwd(cwd);
			cfgTopK.override(settings, 3);
			cfgTemperature.get(settings);
			cfgTemperature.get(settings.overlay());
			await settings.cloneForCwd(cwd);
			expect(invalid()).toHaveLength(1);
			expect(unknownItems()).toHaveLength(1);

			// Fixing the value in the same instance re-arms it.
			cfgTemperature.override(settings, 0.5);
			cfgTemperature.get(settings);
			cfgTemperature.clearOverride(settings);
			cfgTemperature.get(settings);
			expect(invalid()).toHaveLength(2);
		} finally {
			vi.restoreAllMocks();
			tempDir.removeSync();
		}
	});

	it("keeps an overlay's inherited values in its cwd clone and in layer accessors", async () => {
		const parent = Settings.isolated({ temperature: 0.2 });
		parent.setModelRole("smol", "anthropic/parent-global");
		const child = parent.overlay({ topP: 0.5 });

		const clone = await child.cloneForCwd(parent.getCwd());
		expect(cfgTemperature.get(clone)).toBe(0.2);
		expect(cfgTemperature.provenance(clone)).toBe("runtime");
		expect(cfgTopP.get(clone)).toBe(0.5);
		expect(clone.getModelRole("smol")).toBe("anthropic/parent-global");

		expect(child.getGlobalModelRole("smol")).toBe("anthropic/parent-global");
		expect(child.getModelRoleSource("smol")).toBe("global");
		expect(child.getModelRoleProvenance("smol")).toBe("global");
		expect(child.getGlobalSettings()).toMatchObject({ modelRoles: { smol: "anthropic/parent-global" } });
	});

	it("drives effects synchronously from the newest outstanding hold only", () => {
		const applied: number[] = [];
		const removeEffect = effect(cfgTemperature, value => {
			applied.push(value);
		});
		const outer = Settings.isolated({ temperature: 0.2 });
		const inner = Settings.isolated({ temperature: 0.4 });
		const releaseOuter = bindEffects(outer);
		const releaseInner = bindEffects(inner);
		const releaseRepeat = bindEffects(inner);
		try {
			expect(applied.at(-1)).toBe(0.4);
			cfgTemperature.override(inner, 0.5);
			expect(applied.at(-1)).toBe(0.5);

			const seen = applied.length;
			cfgTemperature.override(inner.overlay(), 0.9);
			cfgTemperature.override(outer, 0.3);
			expect(applied).toHaveLength(seen);

			// A repeat holder's release (idempotent) leaves the other hold on the same instance in charge.
			releaseRepeat();
			releaseRepeat();
			cfgTemperature.override(inner, 0.6);
			expect(applied.at(-1)).toBe(0.6);

			// Releasing the newest hold hands effects back to the previous one, re-applying its value.
			releaseInner();
			expect(applied.at(-1)).toBe(0.3);
			cfgTemperature.override(inner, 0.7);
			expect(applied.at(-1)).toBe(0.3);
		} finally {
			removeEffect();
			releaseRepeat();
			releaseInner();
			releaseOuter();
		}
	});

	it("restores effect-owned state to the defaults on test reset", () => {
		let current: number | undefined;
		const removeEffect = effect(cfgTemperature, value => {
			current = value;
		});
		try {
			bindEffects(Settings.isolated({ temperature: 0.4 }));
			expect(current).toBe(0.4);
			resetSettingsForTest();
			expect(current).toBe(cfgTemperature.default);
		} finally {
			removeEffect();
		}
	});

	it("lists every registered setting exactly once in panel order", () => {
		const ordered = orderedSettings();
		expect(new Set(ordered).size).toBe(ordered.length);
		expect(new Set(ordered)).toEqual(new Set(all()));
	});

	it("rejects overrides for unknown setting ids", () => {
		expect(() => Settings.isolated({ temprature: 0.2 })).toThrow('Unknown setting "temprature"');
		expect(() => Settings.isolated().overlay({ "nope.nope": 1 })).toThrow('Unknown setting "nope.nope"');
	});

	it("migrates, normalizes, and validates constructor overrides like handle writes", () => {
		expect(cfgSteeringMode.get(Settings.isolated({ queueMode: "all" }))).toBe("all");
		expect(
			cfgProvidersMaxInFlightRequests.get(Settings.isolated({ "providers.maxInFlightRequests": { openai: 2.7 } })),
		).toEqual({ openai: 2 });
		expect(() => Settings.isolated({ "providers.maxInFlightRequests": { openai: 0 } })).toThrow(
			"Provider request limits must be positive numbers: openai",
		);
		expect(() =>
			Settings.isolated().overlay({ "task.agentCompactionThresholdOverrides": { scout: "eighty" } }),
		).toThrow("Invalid task.agentCompactionThresholdOverrides.scout");
		expect(() => Settings.isolated({ temperature: "hot" })).toThrow("Invalid value for temperature");
		expect(cfgModelRoles.get(Settings.isolated({ modelRoles: { smol: "a/b" } }))).toEqual({ smol: "a/b" });
	});
});
