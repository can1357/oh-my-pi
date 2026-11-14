/**
 * Host resource pressure: a point-in-time snapshot of what can starve a
 * running job on this machine. On Linux it reads pressure stall information
 * (`/proc/pressure/{cpu,memory,io}`), memory and swap totals from
 * `/proc/meminfo`, and the free space of the working directory's filesystem.
 * Any other platform, or any read error, yields `undefined`: callers treat the
 * snapshot as optional context, never as a failure.
 *
 * Self-contained (only `node:` imports) so it can be shared verbatim.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Share of wall time, in percent, that tasks stalled on a resource over 10 s and 60 s. */
export interface PressureAverages {
	avg10: number;
	avg60: number;
}

/** One `/proc/pressure/<resource>` file: `some` task stalled, and `full` (all tasks stalled) where the kernel reports it. */
export interface ResourcePressure {
	some: PressureAverages;
	full?: PressureAverages;
}

export interface HostPressure {
	cpu: ResourcePressure;
	memory: ResourcePressure;
	io: ResourcePressure;
	memTotalBytes: number;
	memAvailableBytes: number;
	swapTotalBytes: number;
	swapFreeBytes: number;
	/** Filesystem holding the working directory. */
	diskTotalBytes: number;
	diskFreeBytes: number;
}

/** Rounded, compact form of a {@link HostPressure} for a judge's state (a type alias, so it is JSON-indexable). */
export type HostPressureSummary = {
	/** Stall percentages: `some`/`full` over 10 s and 60 s. */
	psi: Record<"cpu" | "memory" | "io", { some10: number; some60: number; full10?: number; full60?: number }>;
	memory_gib: { available: number; total: number };
	swap_gib: { used: number; total: number };
	disk_gib: { free: number; total: number };
};

const GIB = 1024 ** 3;

/** `memory.full` avg10 (%) at or above which tasks are starved for memory. */
const MEMORY_FULL_STRAIN = 5;
/** Share of memory still available below which the host is short of memory. */
const MEMORY_AVAILABLE_STRAIN = 0.1;
/** Share of swap in use at or above which the host is swapping heavily. */
const SWAP_USED_STRAIN = 0.5;
/** Share of disk free below which the disk is nearly full. */
const DISK_FREE_STRAIN = 0.05;
/** Free disk bytes below which the disk is nearly full, whatever its size. */
const DISK_FREE_MIN_BYTES = GIB;
/** `cpu.some` avg10 (%) at or above which the CPU is saturated. */
const CPU_SOME_STRAIN = 80;
/** `io.full` avg10 (%) at or above which tasks are stalled on I/O. */
const IO_FULL_STRAIN = 20;

/** Parses one `/proc/pressure/<resource>` file; `undefined` when it holds no `some` line. */
export function parsePressure(text: string): ResourcePressure | undefined {
	let some: PressureAverages | undefined;
	let full: PressureAverages | undefined;
	for (const line of text.split("\n")) {
		const match = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)/.exec(line.trim());
		if (!match) continue;
		const averages = { avg10: Number(match[2]), avg60: Number(match[3]) };
		if (!Number.isFinite(averages.avg10) || !Number.isFinite(averages.avg60)) return undefined;
		if (match[1] === "some") some = averages;
		else full = averages;
	}
	if (!some) return undefined;
	return full ? { some, full } : { some };
}

/** Parses the memory and swap fields of `/proc/meminfo` into bytes; `undefined` when one is missing. */
export function parseMeminfo(
	text: string,
): Pick<HostPressure, "memTotalBytes" | "memAvailableBytes" | "swapTotalBytes" | "swapFreeBytes"> | undefined {
	const kib = new Map<string, number>();
	for (const line of text.split("\n")) {
		const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
		if (match) kib.set(match[1]!, Number(match[2]));
	}
	const memTotal = kib.get("MemTotal");
	const memAvailable = kib.get("MemAvailable");
	const swapTotal = kib.get("SwapTotal");
	const swapFree = kib.get("SwapFree");
	if (memTotal === undefined || memAvailable === undefined || swapTotal === undefined || swapFree === undefined) {
		return undefined;
	}
	return {
		memTotalBytes: memTotal * 1024,
		memAvailableBytes: memAvailable * 1024,
		swapTotalBytes: swapTotal * 1024,
		swapFreeBytes: swapFree * 1024,
	};
}

/**
 * Snapshot of host pressure for the filesystem holding `cwd`; `undefined` off
 * Linux or when any source cannot be read or parsed. `procRoot` points the
 * `/proc` reads elsewhere (fixtures).
 */
export async function readHostPressure(cwd: string, procRoot = "/proc"): Promise<HostPressure | undefined> {
	if (process.platform !== "linux") return undefined;
	try {
		// procfs files report size 0, so read them as streams of unknown length.
		const [cpuText, memoryText, ioText, meminfoText, disk] = await Promise.all([
			fs.readFile(path.join(procRoot, "pressure", "cpu"), "utf8"),
			fs.readFile(path.join(procRoot, "pressure", "memory"), "utf8"),
			fs.readFile(path.join(procRoot, "pressure", "io"), "utf8"),
			fs.readFile(path.join(procRoot, "meminfo"), "utf8"),
			fs.statfs(cwd),
		]);
		const cpu = parsePressure(cpuText);
		const memory = parsePressure(memoryText);
		const io = parsePressure(ioText);
		const meminfo = parseMeminfo(meminfoText);
		if (!cpu || !memory || !io || !meminfo) return undefined;
		return {
			cpu,
			memory,
			io,
			...meminfo,
			diskTotalBytes: disk.blocks * disk.bsize,
			diskFreeBytes: disk.bavail * disk.bsize,
		};
	} catch {
		return undefined;
	}
}

/** One decimal place. */
function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** The snapshot rounded to one decimal, sizes in GiB, for a judge's state. */
export function summarizeHostPressure(pressure: HostPressure): HostPressureSummary {
	const psi = (resource: ResourcePressure) => ({
		some10: round1(resource.some.avg10),
		some60: round1(resource.some.avg60),
		...(resource.full ? { full10: round1(resource.full.avg10), full60: round1(resource.full.avg60) } : {}),
	});
	return {
		psi: { cpu: psi(pressure.cpu), memory: psi(pressure.memory), io: psi(pressure.io) },
		memory_gib: { available: round1(pressure.memAvailableBytes / GIB), total: round1(pressure.memTotalBytes / GIB) },
		swap_gib: {
			used: round1((pressure.swapTotalBytes - pressure.swapFreeBytes) / GIB),
			total: round1(pressure.swapTotalBytes / GIB),
		},
		disk_gib: { free: round1(pressure.diskFreeBytes / GIB), total: round1(pressure.diskTotalBytes / GIB) },
	};
}

/**
 * The kinds of strain the snapshot shows, as short phrases (`memory pressure`,
 * `heavy swapping`, `a nearly full disk`, `CPU saturation`, `I/O stalls`);
 * empty when the host looks unstrained.
 */
export function hostStrain(pressure: HostPressure): string[] {
	const strain: string[] = [];
	if (
		(pressure.memory.full?.avg10 ?? 0) >= MEMORY_FULL_STRAIN ||
		(pressure.memTotalBytes > 0 && pressure.memAvailableBytes / pressure.memTotalBytes < MEMORY_AVAILABLE_STRAIN)
	) {
		strain.push("memory pressure");
	}
	if (
		pressure.swapTotalBytes > 0 &&
		(pressure.swapTotalBytes - pressure.swapFreeBytes) / pressure.swapTotalBytes >= SWAP_USED_STRAIN
	) {
		strain.push("heavy swapping");
	}
	if (
		pressure.diskTotalBytes > 0 &&
		(pressure.diskFreeBytes / pressure.diskTotalBytes < DISK_FREE_STRAIN ||
			pressure.diskFreeBytes < DISK_FREE_MIN_BYTES)
	) {
		strain.push("a nearly full disk");
	}
	if (pressure.cpu.some.avg10 >= CPU_SOME_STRAIN) strain.push("CPU saturation");
	if ((pressure.io.full?.avg10 ?? 0) >= IO_FULL_STRAIN) strain.push("I/O stalls");
	return strain;
}
