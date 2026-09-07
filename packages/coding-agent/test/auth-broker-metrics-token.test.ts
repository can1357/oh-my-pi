import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	resolveEnableMetricsFlag,
	resolveServeMetrics,
	runAuthBrokerCommand,
	type ServeMetricsDecision,
} from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getAgentDir,
	getConfigRootDir,
	refreshDirsFromEnv,
	removeWithRetries,
	setAgentDir,
} from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

// Captured at module load, before any suite calls `setAgentDir`. The mint suite
// below must restore the shared resolver to this on teardown so later
// full-suite tests never resolve agent paths through a deleted temp dir.
const PRISTINE_AGENT_DIR = getAgentDir();

function silenceStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

// The scrape-scoped `/metrics` token. The broker CLI is the single
// deterministic mint source: it writes the token to `$HOME/.omp/auth-broker-metrics.token`
// (0600, no trailing newline).
describe("auth-broker token --metrics (scrape-scoped mint)", () => {
	let agentDir = "";
	let tempHome = "";
	let homedirSpy: Mock<typeof os.homedir> | undefined;
	// Snapshot the full resolver-driving env before any override so teardown can
	// restore it. `setAgentDir` mutates the shared dirs resolver AND deletes
	// `OMP_PROFILE`/`PI_PROFILE` while forcing `PI_CODING_AGENT_DIR`; restoring
	// only an agent path would strand a later full-suite test that ran under an
	// active profile on the default profile. Save every var `setAgentDir` touches
	// and rebuild resolver state from the restored env with the reset helper.
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalOmpProfile = process.env.OMP_PROFILE;
	const originalPiProfile = process.env.PI_PROFILE;
	const bearerPath = (): string => path.join(getConfigRootDir(), "auth-broker.token");
	const metricsPath = (): string => path.join(getConfigRootDir(), "auth-broker-metrics.token");

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metrics-token-"));
		// `getConfigRootDir()` — which fixes both token paths below — is derived
		// from `os.homedir()` when the resolver is built and is NOT redirected by
		// `setAgentDir`. Without a temp HOME this suite mints into the developer's
		// real `~/.omp`, overwriting a live broker's tokens.
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metrics-token-home-"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		// Drop the HOME override before rebuilding, so the restored resolver is
		// anchored on the real home again.
		homedirSpy?.mockRestore();
		homedirSpy = undefined;
		// Restore every var `setAgentDir` mutated, then rebuild the shared resolver
		// from that env so a profile active before this suite survives.
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDir);
		restoreEnvValue("OMP_PROFILE", originalOmpProfile);
		restoreEnvValue("PI_PROFILE", originalPiProfile);
		__resetDirsFromEnvForTests();
		await removeWithRetries(agentDir);
		await removeWithRetries(tempHome);
	});

	test("mints the scrape token to the fixed metrics path, 0600, no trailing newline", async () => {
		const read = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const printed = read();

		const raw = await Bun.file(metricsPath()).text();
		// No trailing newline: the file bytes ARE the bearer value staged verbatim.
		expect(raw).not.toMatch(/\n$/);
		expect(raw.length).toBeGreaterThan(0);
		// The printed token matches the file contents (T2 can read either).
		expect(printed.trim()).toBe(raw);

		const mode = (await fs.stat(metricsPath())).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test("is idempotent: a second mint returns the same token", async () => {
		const read1 = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const first = read1().trim();

		const read2 = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const second = read2().trim();

		expect(second).toBe(first);
		expect(await Bun.file(metricsPath()).text()).toBe(first);
	});

	test("--regenerate rotates the metrics token in place", async () => {
		const read1 = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const before = read1().trim();

		const read2 = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true, regenerate: true } });
		const after = read2().trim();

		expect(after).not.toBe(before);
		expect(await Bun.file(metricsPath()).text()).toBe(after);
	});

	test("metrics token is independent of the master bearer (distinct files + values)", async () => {
		const readBearer = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: {} });
		const bearer = readBearer().trim();

		const readMetrics = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true } });
		const metrics = readMetrics().trim();

		// Two distinct files, two distinct random values — the scrape cred is never
		// the vault-authorizing master bearer.
		expect(metrics).not.toBe(bearer);
		expect(await Bun.file(bearerPath()).text()).toBe(bearer);
		expect(await Bun.file(metricsPath()).text()).toBe(metrics);

		// Rotating the master bearer must not touch the metrics token, and vice versa.
		const readRegen = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { regenerate: true } });
		const newBearer = readRegen().trim();
		expect(newBearer).not.toBe(bearer);
		expect(await Bun.file(metricsPath()).text()).toBe(metrics);
	});

	test("emits both token path and value as JSON when --json is set", async () => {
		const read = silenceStdout();
		await runAuthBrokerCommand({ action: "token", flags: { metrics: true, json: true } });
		const parsed = JSON.parse(read().trim()) as { token: string; path: string };

		expect(parsed.path).toBe(metricsPath());
		expect(parsed.token).toBe(await Bun.file(metricsPath()).text());
	});
});

// Full-suite safety: the mint suite above overrides the shared dirs resolver in
// `beforeEach` and must undo that in `afterEach`. A later suite in the same
// worker relies on the resolver pointing back at the real agent dir; if teardown
// restored only an unrelated env var, this resolves through the deleted temp dir
// instead. Ordering-dependent by design — this must run after the mint suite.
describe("agent-dir resolver is restored after the mint suite", () => {
	test("getAgentDir returns the pristine dir, not a torn-down temp dir", () => {
		expect(getAgentDir()).toBe(PRISTINE_AGENT_DIR);
	});
});

// F3 regression: the mint suite's teardown must restore a profile that was
// active before it ran, not just an agent path. This exercises the exact
// save + restore + resolver-rebuild sequence the suite's afterEach uses. A
// teardown that called only `setAgentDir` (which deletes OMP_PROFILE/PI_PROFILE)
// would strand a later full-suite test on the default profile.
describe("mint-suite teardown restores an active profile", () => {
	test("OMP_PROFILE active before the override is restored after teardown", async () => {
		const ambientOmp = process.env.OMP_PROFILE;
		const ambientPi = process.env.PI_PROFILE;
		const ambientAgent = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.OMP_PROFILE = "auth-broker-metrics-token-profile";
			delete process.env.PI_PROFILE;
			// Suite-body snapshot (what the mint suite captures before any override).
			const savedOmp = process.env.OMP_PROFILE;
			const savedPi = process.env.PI_PROFILE;
			const savedAgent = process.env.PI_CODING_AGENT_DIR;
			// beforeEach override.
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metrics-token-f3-"));
			setAgentDir(tmp);
			expect(process.env.OMP_PROFILE).toBeUndefined();
			// afterEach restore (the fixed sequence).
			restoreEnvValue("PI_CODING_AGENT_DIR", savedAgent);
			restoreEnvValue("OMP_PROFILE", savedOmp);
			restoreEnvValue("PI_PROFILE", savedPi);
			__resetDirsFromEnvForTests();
			await removeWithRetries(tmp);
			expect(process.env.OMP_PROFILE).toBe("auth-broker-metrics-token-profile");
			expect(getActiveProfile()).toBe("auth-broker-metrics-token-profile");
		} finally {
			restoreEnvValue("OMP_PROFILE", ambientOmp);
			restoreEnvValue("PI_PROFILE", ambientPi);
			restoreEnvValue("PI_CODING_AGENT_DIR", ambientAgent);
			__resetDirsFromEnvForTests();
		}
	});
});

/**
 * Assert the decision is the enabled arm and hand back its token-carrying shape,
 * so a case that cares about the token reads it directly instead of re-narrowing
 * the union at every assertion.
 */
function expectEnabled(decision: ServeMetricsDecision): { token: string; source: string } {
	expect(decision.enabled).toBe(true);
	if (!decision.enabled) throw new Error("unreachable: decision asserted enabled above");
	return decision;
}

// The `/metrics` endpoint is opt-in: enablement comes from the `--enable-metrics`
// flag, then `OMP_AUTH_BROKER_METRICS`, then `auth.broker.metrics` in config.
// These drive `resolveServeMetrics` — the exact decision `serve` wires into
// `startAuthBroker` — rather than booting a broker, so the assertions are about
// wiring and on-disk effects with no port or socket in play.
//
// Isolation: `getConfigRootDir()` (which fixes the scrape-token path) derives
// from `os.homedir()` at resolver-construction time and is NOT redirected by
// `setAgentDir`, so a temp HOME plus a resolver rebuild is the only way to keep
// a mint away from the real `~/.omp`. Both the spy and the resolver are restored
// in `afterEach` so a failure mid-test cannot leak either.
describe("auth-broker serve /metrics opt-in", () => {
	const METRICS_ENV = "OMP_AUTH_BROKER_METRICS";
	const TOKEN_ENV = "OMP_AUTH_BROKER_METRICS_TOKEN";
	const TOKEN_FILE_ENV = "OMP_AUTH_BROKER_METRICS_TOKEN_FILE";

	let tempHome = "";
	let homedirSpy: Mock<typeof os.homedir> | undefined;
	const savedEnv: Record<string, string | undefined> = {};

	const metricsTokenPath = (): string => path.join(getConfigRootDir(), "auth-broker-metrics.token");

	/** Write the agent-level `config.yml` the weakest enablement source reads. */
	const writeAgentConfig = async (body: string): Promise<void> => {
		const agentDir = path.join(getConfigRootDir(), "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), body);
	};

	beforeEach(async () => {
		for (const key of [METRICS_ENV, TOKEN_ENV, TOKEN_FILE_ENV]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-metrics-optin-"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
		refreshDirsFromEnv();
	});

	afterEach(async () => {
		homedirSpy?.mockRestore();
		homedirSpy = undefined;
		refreshDirsFromEnv();
		for (const key of [METRICS_ENV, TOKEN_ENV, TOKEN_FILE_ENV]) {
			restoreEnvValue(key, savedEnv[key]);
		}
		await removeWithRetries(tempHome);
	});

	// The reviewer's objection, encoded: an existing deployment that upgrades and
	// changes nothing must gain neither the endpoint nor a new on-disk secret.
	test("default is disabled and mints no token file", async () => {
		const decision = await resolveServeMetrics(undefined);

		expect(decision.enabled).toBe(false);
		expect(await Bun.file(metricsTokenPath()).exists()).toBe(false);
	});

	// `isAuthorized()` trims the bearer value from the Authorization header before
	// comparing, so a stored token carrying a stray newline could never match and
	// every scrape would 401 forever. A file-backed secret piped into the env is
	// the common way that whitespace arrives.
	test("trims whitespace from an injected metrics token", async () => {
		process.env[METRICS_ENV] = "1";
		process.env[TOKEN_ENV] = "  scrape-token-value\n";

		const decision = await resolveServeMetrics(undefined);

		// Narrow the discriminated union before reading the enabled arm's fields.
		if (!decision.enabled) throw new Error("Expected /metrics to be enabled");
		expect(decision.token).toBe("scrape-token-value");
		expect(decision.source).toBe(TOKEN_ENV);
	});

	test("rejects a whitespace-only injected metrics token", async () => {
		process.env[METRICS_ENV] = "1";
		process.env[TOKEN_ENV] = "   \n";

		// Storing "" would leave the token set empty, which disables auth entirely
		// (`isAuthorized` returns true when the set is empty) — fail loudly instead.
		await expect(resolveServeMetrics(undefined)).rejects.toThrow(/only whitespace/i);
	});

	test("--no-enable-metrics overrides an inherited env enable", async () => {
		// The parser cannot produce `false` for a boolean flag, so this negation is
		// the only CLI spelling that can turn off an inherited enable. Without it
		// the documented flag-over-env precedence works in one direction only.
		process.env[METRICS_ENV] = "1";
		expect(resolveEnableMetricsFlag(undefined, true)).toBe(false);
		const decision = await resolveServeMetrics(resolveEnableMetricsFlag(undefined, true));
		expect(decision.enabled).toBe(false);
	});

	test("--no-enable-metrics overrides an inherited config enable", async () => {
		await writeAgentConfig("auth:\n  broker:\n    metrics: true\n");

		const decision = await resolveServeMetrics(resolveEnableMetricsFlag(undefined, true));
		expect(decision.enabled).toBe(false);
	});

	test("passing both metrics flags is an operator error", () => {
		expect(() => resolveEnableMetricsFlag(true, true)).toThrow(/cannot be used together/i);
	});

	test("neither flag defers to env and config", () => {
		expect(resolveEnableMetricsFlag(undefined, undefined)).toBeUndefined();
		expect(resolveEnableMetricsFlag(true, undefined)).toBe(true);
		expect(resolveEnableMetricsFlag(undefined, false)).toBeUndefined();
	});

	test("config alone enables it", async () => {
		await writeAgentConfig("auth:\n  broker:\n    metrics: true\n");

		expect((await resolveServeMetrics(undefined)).enabled).toBe(true);
	});

	test("env alone enables it", async () => {
		process.env[METRICS_ENV] = "1";

		expect((await resolveServeMetrics(undefined)).enabled).toBe(true);
	});

	test("the flag alone enables it", async () => {
		expect((await resolveServeMetrics(true)).enabled).toBe(true);
	});

	test("only 1/true enable via env; other values leave it off", async () => {
		for (const raw of ["1", "true", "TRUE"]) {
			process.env[METRICS_ENV] = raw;
			expect((await resolveServeMetrics(undefined)).enabled).toBe(true);
		}
		// A leftover `=0` or a typo must not open the endpoint.
		for (const raw of ["0", "false", "", "yes"]) {
			process.env[METRICS_ENV] = raw;
			expect((await resolveServeMetrics(undefined)).enabled).toBe(false);
		}
	});

	test("the flag beats a contradicting env, in both directions", async () => {
		process.env[METRICS_ENV] = "0";
		expect((await resolveServeMetrics(true)).enabled).toBe(true);

		process.env[METRICS_ENV] = "1";
		expect((await resolveServeMetrics(false)).enabled).toBe(false);
	});

	test("env beats a contradicting config, in both directions", async () => {
		await writeAgentConfig("auth:\n  broker:\n    metrics: false\n");
		process.env[METRICS_ENV] = "1";
		expect((await resolveServeMetrics(undefined)).enabled).toBe(true);

		await writeAgentConfig("auth:\n  broker:\n    metrics: true\n");
		process.env[METRICS_ENV] = "0";
		expect((await resolveServeMetrics(undefined)).enabled).toBe(false);
	});

	// An absent boolean flag must fall THROUGH to env/config rather than forcing
	// `false`, otherwise env and config could never enable anything.
	test("an absent flag falls through to config instead of forcing false", async () => {
		await writeAgentConfig("auth:\n  broker:\n    metrics: true\n");

		expect((await resolveServeMetrics(undefined)).enabled).toBe(true);
		// An explicit `false` is a real answer and wins.
		expect((await resolveServeMetrics(false)).enabled).toBe(false);
	});

	test("enabled with no injection mints the scrape token to the fixed path", async () => {
		const decision = await resolveServeMetrics(true);

		const enabled = expectEnabled(decision);
		expect(await Bun.file(metricsTokenPath()).text()).toBe(enabled.token);
		expect(enabled.source).toBe(metricsTokenPath());
	});

	test("an injected token value is used verbatim and nothing is written to disk", async () => {
		process.env[TOKEN_ENV] = "injected-scrape-token";

		const enabled = expectEnabled(await resolveServeMetrics(true));

		expect(enabled.token).toBe("injected-scrape-token");
		// Provisioned means provisioned: no second copy of the secret appears.
		expect(await Bun.file(metricsTokenPath()).exists()).toBe(false);
	});

	test("an injected token file is read, newline-trimmed, and mints nothing", async () => {
		const mounted = path.join(tempHome, "scrape-secret");
		// A mounted k8s secret / systemd credential normally ends in a newline.
		await Bun.write(mounted, "file-scrape-token\n");
		process.env[TOKEN_FILE_ENV] = mounted;

		const enabled = expectEnabled(await resolveServeMetrics(true));

		expect(enabled.token).toBe("file-scrape-token");
		expect(enabled.source).toBe(mounted);
		expect(await Bun.file(metricsTokenPath()).exists()).toBe(false);
	});

	test("setting both injection vars is rejected rather than silently resolved", async () => {
		process.env[TOKEN_ENV] = "from-value";
		process.env[TOKEN_FILE_ENV] = path.join(tempHome, "scrape-secret");

		await expect(resolveServeMetrics(true)).rejects.toThrow(/only one of/i);
		expect(await Bun.file(metricsTokenPath()).exists()).toBe(false);
	});

	// Injection is consulted only on the enabled path, so a disabled broker with
	// injection vars still exposes nothing.
	test("injection vars do not by themselves enable the endpoint", async () => {
		process.env[TOKEN_ENV] = "injected-scrape-token";

		expect((await resolveServeMetrics(undefined)).enabled).toBe(false);
	});
});
