import type {
	SandboxCapabilities,
	SandboxIdMapEntry,
	SandboxFacts,
	SandboxHost,
	SandboxNamespaceName,
	SandboxNamespaceState,
	SandboxRootListing,
	SandboxSeccompMode,
} from "./types";

/** `PROC_*_INIT_INO` from the kernel's proc_ns.h. */
const INIT_INODES: Partial<Record<SandboxNamespaceName, number>> = {
	user: 0xeffffffd,
	pid: 0xeffffffc,
	uts: 0xeffffffe,
	ipc: 0xefffffff,
	cgroup: 0xeffffffb,
	time: 0xeffffffa,
};

export const SANDBOX_NAMESPACES: SandboxNamespaceName[] = ["mnt", "net", "user", "pid", "uts", "ipc", "cgroup", "time"];

const SECCOMP_MODES: Record<string, SandboxSeccompMode> = { "0": "disabled", "1": "strict", "2": "filter" };

/** Local filesystems: no server decides a read of a root-owned, world-readable directory, only an LSM or an ACL. */
const LOCAL_FS_TYPES = new Set(["ext4", "xfs", "btrfs", "tmpfs", "overlay", "zfs", "f2fs"]);

/** /proc/self/status as key -> value. */
function parseProcStatus(text: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!text) return out;
	for (const line of text.split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
	}
	return out;
}

/** Validated link inode, kept as text so no numeric precision is lost. */
function namespaceInode(name: SandboxNamespaceName, link: string | undefined): string | undefined {
	const match = /^([a-z_]+):\[([1-9]\d*)\]$/.exec(link?.trim() ?? "");
	return match?.[1] === name ? match[2] : undefined;
}

/** Six fixed init comparisons; /proc/1 is no reliable host baseline for mnt/net. */
function namespaceState(name: SandboxNamespaceName, link: string | undefined): SandboxNamespaceState {
	const inode = namespaceInode(name, link);
	const initial = INIT_INODES[name];
	if (!inode || initial === undefined) return "unknown";
	return inode === String(initial) ? "initial" : "non-initial";
}

function unsigned(text: string | undefined): number | undefined {
	if (!text || !/^\d+$/.test(text)) return undefined;
	const value = Number(text);
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A malformed line invalidates the map rather than presenting a partial identity mapping. */
function parseNamespaceIdMap(text: string | undefined): SandboxIdMapEntry[] | undefined {
	if (!text?.trim()) return undefined;
	const entries: SandboxIdMapEntry[] = [];
	for (const line of text.trim().split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length !== 3) return undefined;
		const [inside, outside, length] = fields.map(unsigned);
		if (
			inside === undefined ||
			outside === undefined ||
			length === undefined ||
			length === 0 ||
			inside + length > 0x100000000 ||
			outside + length > 0x100000000
		)
			return undefined;
		entries.push({ inside, outside, length });
	}
	return entries;
}

/** Type of the filesystem mounted on `/`; the last mountinfo row for `/` is the one on top. */
function rootFsType(mountinfo: string | undefined): string | undefined {
	let fsType: string | undefined;
	for (const line of mountinfo?.split("\n") ?? []) {
		const fields = line.split(" ");
		if (fields[4] !== "/") continue;
		const dash = fields.indexOf("-");
		fsType = dash > 0 ? fields[dash + 1] : undefined;
	}
	return fsType;
}

function optionalText(text: string | undefined): string | undefined {
	const value = text?.trim();
	return value && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : undefined;
}

function attempt<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

/**
 * Only a root-owned, world-readable `/` on a local filesystem counts: there a refused listing comes from an LSM,
 * or from an ACL entry on `/` naming the user, which the mode bits cannot tell apart. An allowed one proves
 * nothing, since an LSM policy may grant `/`.
 */
export function classifyRootListing(
	root: SandboxRootListing | undefined,
	fsType: string | undefined,
): SandboxFacts["rootListing"] {
	if (!root || root.uid !== 0 || (root.mode & 0o005) !== 0o005) return "unknown";
	if (!fsType || !LOCAL_FS_TYPES.has(fsType)) return "unknown";
	if (root.listing === "ok") return "allowed";
	return root.listing === "other" ? "unknown" : "refused";
}

/** Reads every kernel fact the platform offers. Never throws; what cannot be read stays unknown. */
export function readSandboxFacts(host: SandboxHost): SandboxFacts {
	const namespaces = Object.fromEntries(
		SANDBOX_NAMESPACES.map(name => [name, "unknown"]),
	) as SandboxFacts["namespaces"];
	const facts: SandboxFacts = { namespaces, rootListing: "unknown" };
	if (host.platform === "darwin") {
		const check = attempt(() => host.sandboxCheck());
		if (check !== undefined && check >= 0) facts.seatbelt = check > 0;
		return facts;
	}
	if (host.platform !== "linux") return facts;

	const read = (path: string) => attempt(() => host.readFile(path));
	const status = parseProcStatus(read("/proc/self/status"));
	if (status.NoNewPrivs === "0" || status.NoNewPrivs === "1") facts.noNewPrivs = status.NoNewPrivs === "1";
	const mode = SECCOMP_MODES[status.Seccomp ?? ""];
	if (mode) facts.seccomp = mode;
	const filters = unsigned(status.Seccomp_filters);
	if (filters !== undefined) facts.seccompFilters = filters;
	const capabilities: SandboxCapabilities = {};
	for (const [field, key] of [
		["CapInh", "inheritable"],
		["CapPrm", "permitted"],
		["CapEff", "effective"],
		["CapBnd", "bounding"],
		["CapAmb", "ambient"],
	] as const) {
		const mask = status[field];
		if (mask && /^[0-9a-fA-F]+$/.test(mask)) capabilities[key] = mask;
	}
	if (Object.keys(capabilities).length) facts.capabilities = capabilities;
	const namespaceInodes: NonNullable<SandboxFacts["namespaceInodes"]> = {};
	for (const name of SANDBOX_NAMESPACES) {
		const link = attempt(() => host.readLink(`/proc/self/ns/${name}`));
		namespaces[name] = namespaceState(name, link);
		const inode = namespaceInode(name, link);
		if (inode) namespaceInodes[name] = inode;
	}
	if (Object.keys(namespaceInodes).length) facts.namespaceInodes = namespaceInodes;
	const uid = parseNamespaceIdMap(read("/proc/self/uid_map"));
	const gid = parseNamespaceIdMap(read("/proc/self/gid_map"));
	if (uid || gid) facts.namespaceIdMaps = { ...(uid ? { uid } : {}), ...(gid ? { gid } : {}) };
	facts.rootListing = classifyRootListing(
		attempt(() => host.rootListing()),
		rootFsType(read("/proc/self/mountinfo")),
	);
	const lsm = optionalText(read("/sys/kernel/security/lsm"));
	if (lsm && /^[a-zA-Z0-9_-]+(?:,[a-zA-Z0-9_-]+)*$/.test(lsm)) facts.lsm = lsm.split(",");
	const label = optionalText(read("/proc/self/attr/current"));
	if (label && !label.includes("\n")) facts.lsmLabel = label;
	const cgroup = optionalText(read("/proc/self/cgroup"));
	if (cgroup && cgroup.split("\n").every(line => /^\d+:[^:\s]*:\/[^\r]*$/.test(line))) facts.cgroup = cgroup;
	const yama = unsigned(read("/proc/sys/kernel/yama/ptrace_scope")?.trim());
	if (yama !== undefined && yama <= 3) facts.yamaPtraceScope = yama;
	return facts;
}
