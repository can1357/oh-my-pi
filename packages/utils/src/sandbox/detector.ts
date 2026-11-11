import { sanitizeText } from "../sanitize-text";
import { readSandboxFacts, SANDBOX_NAMESPACES } from "./facts";
import { createSandboxHost } from "./host";
import { BUILTIN_SANDBOX_PROBES } from "./probes/builtin";
import type {
	SandboxDetail,
	SandboxFacts,
	SandboxHost,
	SandboxLandlock,
	SandboxLayer,
	SandboxProbe,
	SandboxStatus,
} from "./types";

const DEFAULT_TIMEOUT_MS = 3000;
const CONFINED_ID = "confined";

/** What the facts prove is in force, as `/sandbox` names it. */
function measuredPhrases(facts: SandboxFacts): string[] {
	const out: string[] = [];
	if (facts.noNewPrivs) out.push("no_new_privs");
	if (facts.seccomp && facts.seccomp !== "disabled") out.push(`seccomp ${facts.seccomp}`);
	if (facts.rootListing === "refused") out.push("listing / refused");
	if (facts.seatbelt) out.push("Seatbelt");
	for (const name of SANDBOX_NAMESPACES) {
		if (facts.namespaces[name] === "non-initial") out.push(`${name} namespace`);
	}
	return out;
}

/**
 * The generic layer for a sandbox no probe names: kernel confinement measured on this process. It needs seccomp
 * with no_new_privs (how bubblewrap, Flatpak and systemd sandboxing confine), a refused listing of `/` (a
 * Landlock, AppArmor or SELinux policy; an ACL entry on `/` reads the same), or a Seatbelt profile; namespaces
 * alone are not a sandbox.
 */
function confinedLayer(facts: SandboxFacts): SandboxLayer | undefined {
	const seccomp = facts.seccomp !== undefined && facts.seccomp !== "disabled";
	if (!(seccomp && facts.noNewPrivs) && facts.rootListing !== "refused" && !facts.seatbelt) return undefined;
	const measured = measuredPhrases(facts);
	return { id: CONFINED_ID, basis: "measured", restrictions: measured, evidence: [`measured ${measured.join(", ")}`] };
}

/** Probe text as one line: escapes and control characters dropped, tabs and newlines collapsed to a space. */
function oneLine(text: string): string {
	return sanitizeText(String(text)).replace(/\s+/g, " ").trim();
}

function cleanDetail(detail: SandboxDetail): SandboxDetail {
	if ("label" in detail) return { label: oneLine(detail.label), value: oneLine(detail.value) };
	if ("files" in detail) {
		const files = detail.files.map(file => ({
			label: oneLine(file.label),
			path: oneLine(file.path),
			...(file.directory === true ? { directory: true } : {}),
		}));
		return { title: oneLine(detail.title), files };
	}
	return { title: oneLine(detail.title), markdown: sanitizeText(String(detail.markdown)) };
}

/**
 * A probe's layer with every string made safe to show: one line each, except a detail's markdown, which keeps
 * its newlines. Throws on a network access the report has no words for.
 */
function cleanLayer(probe: SandboxProbe, layer: SandboxLayer): SandboxLayer {
	const out: SandboxLayer = {
		id: probe.id,
		basis: layer.basis === "measured" ? "measured" : "declared",
		restrictions: (layer.restrictions ?? []).map(oneLine).filter(Boolean),
		evidence: (layer.evidence ?? []).map(oneLine).filter(Boolean),
	};
	const role = layer.role === undefined ? "" : oneLine(layer.role);
	if (role) out.role = role;
	if (layer.files) out.files = { cwd: layer.files.cwd, home: layer.files.home };
	if (layer.network) {
		const { access } = layer.network;
		if (access !== "blocked" && access !== "filtered" && access !== "open") {
			throw new Error("network.access must be blocked, filtered or open");
		}
		out.network = { access };
		const summary = layer.network.summary === undefined ? "" : oneLine(layer.network.summary);
		if (summary) out.network.summary = summary;
	}
	if (layer.details) out.details = layer.details.map(cleanDetail);
	return out;
}

const TIMED_OUT = Symbol("timed out");

type ProbeOutcome = { layer?: SandboxLayer; note: string };

function errorText(err: unknown): string {
	return oneLine(err instanceof Error ? err.message : String(err));
}

function settled(probe: SandboxProbe, layer: SandboxLayer | undefined): ProbeOutcome {
	if (!layer) return { note: `${probe.id}: no match` };
	try {
		const clean = cleanLayer(probe, layer);
		return { layer: clean, note: `${probe.id}: ${clean.basis}` };
	} catch (err) {
		return { note: `${probe.id}: failed: ${errorText(err)}` };
	}
}

/**
 * Runs every registered probe once against `host`, then adds the `confined` layer when no probe matched.
 * Synchronous probes finish without a timer; async ones share one `timeoutMs` budget. A throwing or late probe is
 * recorded in the evidence and contributes no layer.
 */
async function runSandboxDetection(
	host: SandboxHost,
	probes: readonly SandboxProbe[],
	timeoutMs: number,
): Promise<SandboxStatus> {
	const facts = readSandboxFacts(host);
	const controller = new AbortController();
	const pending: (ProbeOutcome | Promise<ProbeOutcome>)[] = probes.map(probe => {
		try {
			const result = probe.detect(host, controller.signal);
			if (!(result instanceof Promise)) return settled(probe, result);
			return result.then(
				layer => settled(probe, layer),
				err => ({ note: `${probe.id}: failed: ${errorText(err)}` }),
			);
		} catch (err) {
			return { note: `${probe.id}: failed: ${errorText(err)}` };
		}
	});

	let outcomes: ProbeOutcome[];
	if (pending.some(p => p instanceof Promise)) {
		const { promise: timeout, resolve } = Promise.withResolvers<typeof TIMED_OUT>();
		const timer = setTimeout(() => {
			controller.abort(new Error("sandbox detection timed out"));
			resolve(TIMED_OUT);
		}, timeoutMs);
		try {
			outcomes = await Promise.all(
				pending.map(async (p, i) => {
					const outcome = await Promise.race([p, timeout]);
					return outcome === TIMED_OUT ? { note: `${probes[i].id}: timed out` } : outcome;
				}),
			);
		} finally {
			clearTimeout(timer);
		}
	} else {
		outcomes = pending as ProbeOutcome[];
	}

	const layers: SandboxLayer[] = [];
	const evidence: string[] = [];
	for (const { layer, note } of outcomes) {
		evidence.push(note);
		if (layer && !layers.some(l => l.id === layer.id)) layers.push(layer);
	}
	if (layers.length === 0) {
		const confined = confinedLayer(facts);
		if (confined) {
			layers.push(confined);
			evidence.push(`confined: ${confined.evidence[0]}`);
		}
	}
	return { platform: host.platform, layers, facts, evidence };
}

/** A host's Landlock answer as the report shows it; a malformed one is `unknown`. */
function landlockFact(landlock: SandboxLandlock | undefined): SandboxLandlock {
	if (
		landlock?.state === "supported" &&
		typeof landlock.abi === "number" &&
		Number.isSafeInteger(landlock.abi) &&
		landlock.abi > 0
	) {
		return { state: "supported", abi: landlock.abi };
	}
	if (landlock && ["unsupported", "blocked", "disabled"].includes(landlock.state)) return { state: landlock.state };
	return { state: "unknown" };
}

/**
 * `status` with what detection leaves out as too slow: the kernel's Landlock ABI on Linux, and the details each
 * matched probe's `report()` returns, appended to its layer. All of it shares one `timeoutMs` budget; a report that
 * throws or is late is named in the evidence and adds nothing.
 */
async function runSandboxReport(
	status: SandboxStatus,
	host: SandboxHost,
	probes: ReadonlyMap<string, SandboxProbe>,
	timeoutMs: number,
): Promise<SandboxStatus> {
	const controller = new AbortController();
	const { promise: timeout, resolve } = Promise.withResolvers<typeof TIMED_OUT>();
	const timer = setTimeout(() => {
		controller.abort(new Error("sandbox report timed out"));
		resolve(TIMED_OUT);
	}, timeoutMs);
	const evidence = [...status.evidence];
	const linux = status.platform === "linux";
	try {
		const [landlock, layers] = await Promise.all([
			linux ? Promise.race([(async () => host.landlockAbi?.())().catch(() => undefined), timeout]) : undefined,
			Promise.all(
				status.layers.map(async layer => {
					const probe = probes.get(layer.id);
					if (!probe?.report) return layer;
					try {
						const details = await Promise.race([probe.report(layer, host, controller.signal), timeout]);
						if (details === TIMED_OUT) {
							evidence.push(`${layer.id}: report timed out`);
							return layer;
						}
						return { ...layer, details: [...(layer.details ?? []), ...details.map(cleanDetail)] };
					} catch (err) {
						evidence.push(`${layer.id}: report failed: ${errorText(err)}`);
						return layer;
					}
				}),
			),
		]);
		if (!linux) return { ...status, layers, evidence };
		const facts = { ...status.facts, landlock: landlockFact(landlock === TIMED_OUT ? undefined : landlock) };
		return { ...status, layers, facts, evidence };
	} finally {
		clearTimeout(timer);
	}
}

export interface SandboxDetectorOptions {
	/** The built-in probes when omitted. A later probe with the same id replaces an earlier one. */
	probes?: readonly SandboxProbe[];
	/** Called once per detection run and once per {@link SandboxDetector.inspect}. */
	host?: () => SandboxHost;
	timeoutMs?: number;
}

/**
 * A probe registry keyed by probe id, with a cached status. Registering a probe after a run has started or finished
 * runs detection again, so a late registration (an extension, an SDK host) is never missing from the status.
 */
export class SandboxDetector {
	readonly #probes = new Map<string, SandboxProbe>();
	#host: () => SandboxHost;
	#timeoutMs: number;
	#status: SandboxStatus | undefined;
	#running: Promise<SandboxStatus> | undefined;

	constructor(options: SandboxDetectorOptions = {}) {
		for (const probe of options.probes ?? BUILTIN_SANDBOX_PROBES) this.#add(probe);
		this.#host = options.host ?? (() => createSandboxHost());
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Adds a probe; one with the same id replaces the earlier one in its place. */
	register(probe: SandboxProbe): void {
		this.#add(probe);
		if (this.#status || this.#running) this.#start();
	}

	/** Throws on an id that is not one clean line: the id names the layer in every report line, shown as it is. */
	#add(probe: SandboxProbe): void {
		if (typeof probe.id !== "string" || !probe.id || oneLine(probe.id) !== probe.id) {
			throw new Error(`Invalid sandbox probe id: ${JSON.stringify(probe.id)}`);
		}
		this.#probes.set(probe.id, probe);
	}

	/** The latest status, running detection first when none has run; waits for a re-run a registration started. */
	async detect(): Promise<SandboxStatus> {
		for (;;) {
			const running = this.#running;
			if (running) {
				await running;
				continue;
			}
			if (this.#status) return this.#status;
			this.#start();
		}
	}

	/**
	 * A fresh status with report-time data added. Detection runs again on each call, so a report follows a working
	 * directory that has moved since the cached status was taken; every probe's `report()` runs on each call too.
	 */
	async inspect(): Promise<SandboxStatus> {
		const host = this.#host();
		const status = await runSandboxDetection(host, [...this.#probes.values()], this.#timeoutMs);
		return runSandboxReport(status, host, this.#probes, this.#timeoutMs);
	}

	/** The last finished status, or `undefined` before the first run finishes. */
	get status(): SandboxStatus | undefined {
		return this.#status;
	}

	#start(): void {
		const run = runSandboxDetection(this.#host(), [...this.#probes.values()], this.#timeoutMs);
		this.#running = run;
		run.then(
			status => {
				if (this.#running !== run) return;
				this.#status = status;
				this.#running = undefined;
			},
			() => {
				// `detect()` callers awaiting this run see the error; the next call starts over.
				if (this.#running === run) this.#running = undefined;
			},
		);
	}
}

const detector = new SandboxDetector();

/** Adds a probe to the process-wide detector; see {@link SandboxDetector.register}. */
export function registerSandboxProbe(probe: SandboxProbe): void {
	detector.register(probe);
}

/** The process-wide sandbox status; detection runs on the first call and after a late probe registration. */
export function detectSandbox(): Promise<SandboxStatus> {
	return detector.detect();
}

/** A fresh status with report-time data, for `/sandbox`; see {@link SandboxDetector.inspect}. */
export function inspectSandbox(): Promise<SandboxStatus> {
	return detector.inspect();
}
