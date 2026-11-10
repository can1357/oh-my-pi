import { tryParseJson } from "../json";
import { isRecord } from "../type-guards";
import type {
	SandboxDetail,
	SandboxLayer,
	SandboxNetwork,
	SandboxPolicyFile,
	SandboxProbe,
	SandboxWriteAccess,
} from "./types";

const MAX_LISTED = 6;

function listed(label: string, items: string[]): string {
	const head = items.slice(0, MAX_LISTED).join(", ");
	return items.length > MAX_LISTED ? `${label}: ${head} +${items.length - MAX_LISTED} more` : `${label}: ${head}`;
}

function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
	const parsed = text === undefined ? null : tryParseJson(text);
	return isRecord(parsed) ? parsed : undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

interface NonoGrant {
	/** `path` (canonical) and `original` (as requested), whichever the file has. */
	paths: string[];
	access: string;
}

function trimSlashes(p: string): string {
	return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function covers(grant: string, target: string): boolean {
	const base = trimSlashes(grant);
	return target === base || target.startsWith(base === "/" ? "/" : `${base}/`);
}

/** Write access to `target` under nono's grants: only a `readwrite` or `write` grant allows writes. */
function nonoWriteAccess(target: string | undefined, grants: NonoGrant[], denied: string[]): SandboxWriteAccess {
	if (!target) return "unknown";
	const t = trimSlashes(target);
	if (denied.some(p => covers(p, t))) return "read-only";
	const writable = grants.some(
		g => (g.access === "readwrite" || g.access === "write") && g.paths.some(p => covers(p, t)),
	);
	return writable ? "writable" : "read-only";
}

/** nono's proxy carries `nono` as the userinfo of the proxy URL it hands the child. */
const NONO_PROXY = /^https?:\/\/nono[:@]/i;

/**
 * nono (Landlock on Linux, Seatbelt on macOS) hands the sandboxed child `NONO_CAP_FILE`, a JSON file with the
 * granted paths (`fs[].path` and `original`, and `access`), `deny_paths`, `net_blocked`, `allowed_domains` and
 * `blocked_commands`. Write access to the working directory and home follows from the grants. A session that
 * filters domains through nono's proxy has `allowed_domains`, `NONO_PROXY_TOKEN` or a `nono` proxy login. User
 * profiles live in `$XDG_CONFIG_HOME/nono/profiles` (`~/.config` when unset).
 * Declared: any process of the same user could set the variable and write such a file.
 */
export const nonoProbe: SandboxProbe = {
	id: "nono",
	detect(host) {
		if (host.platform !== "linux" && host.platform !== "darwin") return undefined;
		const capFile = host.env.NONO_CAP_FILE;
		if (!capFile) return undefined;
		const caps = parseJsonRecord(host.readFile(capFile));
		if (!caps || !Array.isArray(caps.fs)) return undefined;

		const grants: NonoGrant[] = [];
		for (const entry of caps.fs) {
			if (!isRecord(entry) || typeof entry.access !== "string") continue;
			const paths = strings([entry.path, entry.original]);
			if (paths.length > 0) grants.push({ paths, access: entry.access });
		}
		const denied = strings(caps.deny_paths);
		const blockedCommands = strings(caps.blocked_commands);
		const restrictions = blockedCommands.length > 0 ? [listed("blocked commands", blockedCommands)] : [];

		let network: SandboxNetwork | undefined;
		const proxy = host.env.HTTPS_PROXY ?? host.env.https_proxy ?? "";
		if (caps.net_blocked === true) network = { access: "blocked" };
		else if (strings(caps.allowed_domains).length > 0 || host.env.NONO_PROXY_TOKEN || NONO_PROXY.test(proxy)) {
			network = { access: "filtered", summary: "through the nono proxy" };
		} else if (caps.net_blocked === false) network = { access: "open" };

		const files: SandboxPolicyFile[] = [{ label: "capability file", path: capFile }];
		const config = host.env.XDG_CONFIG_HOME ?? (host.env.HOME ? `${trimSlashes(host.env.HOME)}/.config` : undefined);
		if (config) files.push({ label: "user profiles", path: `${trimSlashes(config)}/nono/profiles`, directory: true });
		const details: SandboxDetail[] = [{ title: "Policy files", files }];
		if (grants.length > 0 || denied.length > 0) {
			const rows = [
				...grants.map(g => `| ${g.paths[0].replaceAll("|", "\\|")} | ${g.access} |`),
				...denied.map(p => `| ${p.replaceAll("|", "\\|")} | denied |`),
			];
			details.push({ title: "Paths", markdown: ["| Path | Access |", "|---|---|", ...rows].join("\n") });
		}

		const layer: SandboxLayer = {
			id: "nono",
			basis: "declared",
			restrictions,
			files: {
				cwd: nonoWriteAccess(host.cwd, grants, denied),
				home: nonoWriteAccess(host.env.HOME, grants, denied),
			},
			details,
			evidence: [`NONO_CAP_FILE=${capFile} (${grants.length} grants)`],
		};
		if (network) layer.network = network;
		return layer;
	},
};

function declared(id: string, evidence: string): SandboxLayer {
	return { id, basis: "declared", restrictions: [], evidence: [evidence] };
}

/** A Kubernetes pod: the service env and the mounted service account. Declared. */
export const k8sProbe: SandboxProbe = {
	id: "k8s",
	detect(host) {
		if (host.platform !== "linux" || !host.env.KUBERNETES_SERVICE_HOST) return undefined;
		if (!host.exists("/var/run/secrets/kubernetes.io/serviceaccount")) return undefined;
		return declared("k8s", "KUBERNETES_SERVICE_HOST set and a service account mounted");
	},
};

/**
 * A Docker container: `/.dockerenv`, or PID 1's cgroup path names docker. Containerd and CRI containers (most
 * Kubernetes pods) have neither marker, so they are not called docker. Declared.
 */
export const dockerProbe: SandboxProbe = {
	id: "docker",
	detect(host) {
		if (host.platform !== "linux") return undefined;
		if (host.exists("/.dockerenv")) return declared("docker", "/.dockerenv present");
		if (/\bdocker\b/.test(host.readFile("/proc/1/cgroup") ?? "")) {
			return declared("docker", "/proc/1/cgroup names docker");
		}
		return undefined;
	},
};

/** A Podman container: `/run/.containerenv`. Declared. */
export const podmanProbe: SandboxProbe = {
	id: "podman",
	detect(host) {
		if (host.platform !== "linux" || !host.exists("/run/.containerenv")) return undefined;
		return declared("podman", "/run/.containerenv present");
	},
};

/** Outermost first: a pod wraps a container, which may run nono. */
export const BUILTIN_SANDBOX_PROBES: readonly SandboxProbe[] = [k8sProbe, dockerProbe, podmanProbe, nonoProbe];
