import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { all, bindEffects, combine, effect, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

import {
	cfgProvidersMaxInFlightRequests,
	cfgTemperature,
	cfgTopK,
	cfgTopP,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgSteeringMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgEditFuzzyMatch, cfgEditModelVariants } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { cfgTaskMaxConcurrency } from "@oh-my-pi/pi-coding-agent/task/settings";
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
