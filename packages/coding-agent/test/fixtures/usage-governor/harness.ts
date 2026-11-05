/**
 * Shared harness for the usage-governor CLI proof. One `GovernorProof` owns a temp HOME, the
 * loopback fake, the egress tripwire and the child environment. Every child process is spawned
 * through the allowlisted environment from `buildEnv`: nothing else from the parent reaches it.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { checkConfinement, sandboxCommand } from "./confinement";
import { type FakeAccountSpec, type FakeProvider, type FakeRecord, startFakeProvider } from "./fake-provider";
import { type ScenarioSettings, seedAuthDb, writeScenarioConfig } from "./seed";
import { type Tripwire, startTripwire } from "./tripwire";

export const CLI_ENTRY = path.resolve(import.meta.dir, "../../../src/cli.ts");
export const EXTENSION = path.resolve(import.meta.dir, "govplan-extension.ts");
export const CHILD_PROBE = path.resolve(import.meta.dir, "child-probe.ts");

/** Variables a child may inherit from the parent. Everything else is dropped. */
const ALLOWED_PARENT_VARS = ["PATH", "TMPDIR", "TEMP", "TMP"] as const;

/** Inherited names that must never reach a child, whatever their value. */
const FORBIDDEN_CHILD_NAME = /(_API_KEY|_TOKEN)$|^PI_CODING_AGENT_DIR$|^OMP_PROFILE$|^PI_PROFILE$|^XDG_/;

/** Loopback addresses bypass the tripwire: the fake lives there and must be reached directly. */
const LOOPBACK_NO_PROXY = "127.0.0.1,localhost";

/**
 * Strings only the fixtures write: fake bearer tokens, fake account ids and fake emails. The real
 * home's agent database never holds them unless a proof child used the real HOME.
 */
const FIXTURE_MARKERS = ["tok-govplan", "acct-govplan", "govplan-a@example.invalid", "govplan-b@example.invalid"];

export interface OmpResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface LedgerWait {
	id: number;
	startedAtMs: number;
	endedAtMs: number | null;
	outcome: string | null;
	provider: string;
	credentialId: number | null;
	role: string | null;
	source: string;
	pid: number;
	reason: string;
	bindingLabel: string | null;
	used: number | null;
	allowed: number | null;
	untilMs: number | null;
	resetsAtMs: number | null;
}

export interface LedgerReservation {
	id: number;
	grantId: string;
	quotaKey: string;
	generation: number;
	createdAtMs: number;
	settledAtMs: number | null;
	pid: number;
	provider: string;
	credentialId: number | null;
	role: string | null;
	source: string;
	interactive: number;
}

export interface LedgerSnapshot {
	waits: LedgerWait[];
	reservations: LedgerReservation[];
}

interface WaitRow {
	id: number;
	started_at_ms: number;
	ended_at_ms: number | null;
	outcome: string | null;
	provider: string;
	credential_id: number | null;
	role: string | null;
	source: string;
	pid: number;
	reason: string;
	binding_label: string | null;
	used: number | null;
	allowed: number | null;
	until_ms: number | null;
	resets_at_ms: number | null;
}

interface ReservationRow {
	id: number;
	grant_id: string;
	quota_key: string;
	generation: number;
	created_at_ms: number;
	settled_at_ms: number | null;
	pid: number;
	provider: string;
	credential_id: number | null;
	role: string | null;
	source: string;
	interactive: number;
}

/** The real HOME's files the proof must never write. */
export function realHomeFiles(): string[] {
	const home = os.homedir();
	return [path.join(home, ".omp", "usage-governor.db"), path.join(home, ".omp", "agent", "agent.db")];
}

export interface StatSnapshot {
	path: string;
	exists: boolean;
	mtimeMs: number | null;
}

/** Read-only stat of the real-HOME files. Never opens or writes them. */
export function statRealHome(): StatSnapshot[] {
	return realHomeFiles().map(file => {
		try {
			return { path: file, exists: true, mtimeMs: fs.statSync(file).mtimeMs };
		} catch {
			return { path: file, exists: false, mtimeMs: null };
		}
	});
}

/**
 * Count fixture markers in the real agent database and its write-ahead log. Reads bytes only; the
 * files are never opened for writing. A nonzero count means a proof child wrote to the real HOME.
 */
export function realHomeFixtureMarkerHits(): number {
	const agentDb = path.join(os.homedir(), ".omp", "agent", "agent.db");
	let hits = 0;
	for (const file of [agentDb, `${agentDb}-wal`]) {
		if (!fs.existsSync(file)) continue;
		const bytes = fs.readFileSync(file);
		for (const marker of FIXTURE_MARKERS) {
			if (bytes.includes(Buffer.from(marker))) hits += 1;
		}
	}
	return hits;
}

/**
 * Await an observable signal by polling it, with an explicit deadline. Used only for ledger rows
 * and fake records; the poll never stands in for a guessed duration.
 */
export async function awaitCondition(check: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await Bun.sleep(intervalMs);
	}
	return check();
}

/**
 * SQLite may briefly reject a read-only connection while the child initializes WAL sidecars.
 * Retry only that error while polling; a persistent failure must not look like an empty ledger.
 */
export async function awaitLedgerCondition(check: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;
	let lastError: unknown;
	while (true) {
		try {
			const matched = check();
			lastError = undefined;
			if (matched) return true;
		} catch (error) {
			if (
				!(error instanceof Error) ||
				error.name !== "SQLiteError" ||
				!("code" in error) ||
				error.code !== "SQLITE_CANTOPEN"
			) {
				throw error;
			}
			lastError = error;
		}
		const remaining = deadline - performance.now();
		if (remaining <= 0) {
			if (lastError !== undefined) throw lastError;
			return false;
		}
		await Bun.sleep(Math.min(intervalMs, remaining));
	}
}

/** Inherited names among a child's environment keys that must never be present. */
export function forbiddenNames(names: readonly string[]): string[] {
	return names.filter(name => FORBIDDEN_CHILD_NAME.test(name));
}

const EMPTY_LEDGER: LedgerSnapshot = { waits: [], reservations: [] };

export class GovernorProof {
	readonly tempDir: TempDir;
	readonly home: string;
	readonly agentDir: string;
	readonly fake: FakeProvider;
	readonly tripwire: Tripwire;
	readonly specs: readonly FakeAccountSpec[];
	readonly #env: Record<string, string>;
	#confinementChecked = false;

	private constructor(tempDir: TempDir, specs: readonly FakeAccountSpec[]) {
		this.tempDir = tempDir;
		this.home = tempDir.join("home");
		this.agentDir = path.join(this.home, ".omp", "agent");
		this.specs = specs;
		this.fake = startFakeProvider(specs);
		this.tripwire = startTripwire();
		this.#env = this.buildEnv();
	}

	/** A proof with fresh accounts, seeded auth and settings. */
	static async create(specs: readonly FakeAccountSpec[], settings: ScenarioSettings): Promise<GovernorProof> {
		const tempDir = TempDir.createSync("@usage-governor-proof-");
		const proof = new GovernorProof(tempDir, specs);
		try {
			await seedAuthDb(proof.agentDir, specs);
			writeScenarioConfig(proof.agentDir, settings);
			await checkConfinement(proof);
			proof.#confinementChecked = true;
			return proof;
		} catch (error) {
			proof.close();
			throw error;
		}
	}

	/**
	 * The child environment: an allowlist of the parent's PATH and temp variables, a temp HOME,
	 * the fake's URL, and the tripwire proxies. `NO_PROXY` keeps the loopback fake direct.
	 */
	buildEnv(): Record<string, string> {
		const env: Record<string, string> = {};
		for (const name of ALLOWED_PARENT_VARS) {
			const value = process.env[name];
			if (value !== undefined) env[name] = value;
		}
		env.HOME = this.home;
		// os.homedir() reads USERPROFILE on Windows.
		env.USERPROFILE = this.home;
		env.TMPDIR = env.TMPDIR ?? this.tempDir.path();
		env.NO_COLOR = "1";
		env.GOVPLAN_FAKE_URL = this.fake.url;
		env.PI_PROXY = this.tripwire.url;
		env.HTTPS_PROXY = this.tripwire.url;
		env.HTTP_PROXY = this.tripwire.url;
		env.ALL_PROXY = this.tripwire.url;
		env.NO_PROXY = LOOPBACK_NO_PROXY;
		env.no_proxy = LOOPBACK_NO_PROXY;
		return env;
	}

	get env(): Readonly<Record<string, string>> {
		return this.#env;
	}

	/** The argument vector for one `omp` invocation: the compiled binary when `OMP_PROOF_BINARY` is set. */
	ompCommand(args: readonly string[]): string[] {
		const binary = process.env.OMP_PROOF_BINARY;
		const head = binary ? [binary] : [process.execPath, CLI_ENTRY];
		return [...head, "--no-title", "--no-lsp", "-e", EXTENSION, ...args];
	}

	/** Start an `omp` child in the proof's cwd and allowlisted environment. */
	spawnOmp(args: readonly string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
		if (!this.#confinementChecked) throw new Error("confinement controls have not passed for this proof");
		return Bun.spawn(sandboxCommand(this, this.ompCommand(args)), {
			cwd: this.tempDir.path(),
			env: {},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	/** Run `omp` to completion. A watchdog kills it after `timeoutMs`; the exit code then reports the kill. */
	async runOmp(args: readonly string[], timeoutMs = 60_000): Promise<OmpResult> {
		const proc = this.spawnOmp(args);
		const watchdog = setTimeout(() => proc.kill(), timeoutMs);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { exitCode, stdout, stderr };
		} finally {
			clearTimeout(watchdog);
		}
	}

	/**
	 * `omp usage --json`, parsed. The usage subcommand loads extensions from its own `--extension`
	 * flag, so the fixture is passed there for the usage providers to exist.
	 */
	async usageJson(): Promise<Record<string, unknown>> {
		const result = await this.runOmp(["usage", "--json", "--extension", EXTENSION]);
		if (result.exitCode !== 0) throw new Error(`omp usage --json exited ${result.exitCode}: ${result.stderr}`);
		return JSON.parse(result.stdout) as Record<string, unknown>;
	}

	/** `omp usage invalidate`: the next selection refetches every account's usage. */
	async invalidateUsage(): Promise<OmpResult> {
		return this.runOmp(["usage", "invalidate", "--extension", EXTENSION]);
	}

	/** Chat sends the fake served, in arrival order. */
	chats(): FakeRecord[] {
		return this.fake.chats();
	}

	get ledgerPath(): string {
		return path.join(this.agentDir, "usage-governor.db");
	}

	ledgerExists(): boolean {
		return fs.existsSync(this.ledgerPath);
	}

	/**
	 * Read the ledger through a read-only handle. Never writes. A ledger file whose schema is still
	 * being created reads as empty: the child creates the file before its schema transaction commits.
	 */
	readLedger(): LedgerSnapshot {
		if (!this.ledgerExists()) return EMPTY_LEDGER;
		const db = new Database(this.ledgerPath, { readonly: true });
		try {
			const tables = new Set(
				db
					.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all()
					.map(row => row.name),
			);
			if (!tables.has("waits") || !tables.has("reservations")) return EMPTY_LEDGER;
			const waits = db
				.query<WaitRow, []>("SELECT * FROM waits ORDER BY id")
				.all()
				.map(row => ({
					id: row.id,
					startedAtMs: row.started_at_ms,
					endedAtMs: row.ended_at_ms,
					outcome: row.outcome,
					provider: row.provider,
					credentialId: row.credential_id,
					role: row.role,
					source: row.source,
					pid: row.pid,
					reason: row.reason,
					bindingLabel: row.binding_label,
					used: row.used,
					allowed: row.allowed,
					untilMs: row.until_ms,
					resetsAtMs: row.resets_at_ms,
				}));
			const reservations = db
				.query<ReservationRow, []>("SELECT * FROM reservations ORDER BY id")
				.all()
				.map(row => ({
					id: row.id,
					grantId: row.grant_id,
					quotaKey: row.quota_key,
					generation: row.generation,
					createdAtMs: row.created_at_ms,
					settledAtMs: row.settled_at_ms,
					pid: row.pid,
					provider: row.provider,
					credentialId: row.credential_id,
					role: row.role,
					source: row.source,
					interactive: row.interactive,
				}));
			return { waits, reservations };
		} finally {
			db.close();
		}
	}

	/** Stop the fake and the tripwire, and remove the temp HOME. */
	close(): void {
		this.fake.close();
		this.tripwire.close();
		this.tempDir[Symbol.dispose]();
	}
}
