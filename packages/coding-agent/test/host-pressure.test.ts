import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type HostPressure,
	hostStrain,
	parseMeminfo,
	parsePressure,
	readHostPressure,
	summarizeHostPressure,
} from "@oh-my-pi/pi-coding-agent/async/host-pressure";
import { TempDir } from "@oh-my-pi/pi-utils";

const MEMORY_PSI =
	"some avg10=31.20 avg60=12.05 avg300=3.10 total=123456\nfull avg10=9.87 avg60=4.44 avg300=1.00 total=6543\n";
const CPU_PSI = "some avg10=2.50 avg60=1.25 avg300=0.50 total=999\n";
const MEMINFO = [
	"MemTotal:       16384000 kB",
	"MemFree:          200000 kB",
	"MemAvailable:     819200 kB",
	"SwapTotal:       8192000 kB",
	"SwapFree:        2048000 kB",
	"",
].join("\n");

async function writeProc(root: string, files: Record<string, string>): Promise<void> {
	for (const [name, text] of Object.entries(files)) await Bun.write(path.join(root, name), text);
}

describe("host pressure", () => {
	it("parses some and full averages from a PSI file, and only some when full is absent", () => {
		expect(parsePressure(MEMORY_PSI)).toEqual({
			some: { avg10: 31.2, avg60: 12.05 },
			full: { avg10: 9.87, avg60: 4.44 },
		});
		expect(parsePressure(CPU_PSI)).toEqual({ some: { avg10: 2.5, avg60: 1.25 } });
		expect(parsePressure("garbage")).toBeUndefined();
	});

	it("reads memory and swap from meminfo in bytes, and rejects meminfo missing a field", () => {
		expect(parseMeminfo(MEMINFO)).toEqual({
			memTotalBytes: 16384000 * 1024,
			memAvailableBytes: 819200 * 1024,
			swapTotalBytes: 8192000 * 1024,
			swapFreeBytes: 2048000 * 1024,
		});
		expect(parseMeminfo("MemTotal: 1 kB\n")).toBeUndefined();
	});

	it.skipIf(process.platform !== "linux")("reads a full snapshot from a proc tree", async () => {
		using dir = TempDir.createSync("@omp-host-pressure-");
		await writeProc(dir.path(), {
			"pressure/cpu": CPU_PSI,
			"pressure/memory": MEMORY_PSI,
			"pressure/io":
				"some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
			meminfo: MEMINFO,
		});
		const pressure = await readHostPressure(dir.path(), dir.path());
		expect(pressure?.memory.full).toEqual({ avg10: 9.87, avg60: 4.44 });
		expect(pressure?.swapFreeBytes).toBe(2048000 * 1024);
		expect(pressure?.diskTotalBytes).toBeGreaterThan(0);
	});

	it("is undefined when the proc files are missing", async () => {
		using dir = TempDir.createSync("@omp-host-pressure-missing-");
		expect(await readHostPressure(dir.path(), dir.path())).toBeUndefined();
	});

	it("summarizes rounded GiB and names memory, swap and disk strain", () => {
		const gib = 1024 ** 3;
		const strained: HostPressure = {
			cpu: { some: { avg10: 2.5, avg60: 1.26 } },
			memory: { some: { avg10: 31.2, avg60: 12.06 }, full: { avg10: 9.87, avg60: 4.44 } },
			io: { some: { avg10: 0, avg60: 0 } },
			memTotalBytes: 16 * gib,
			memAvailableBytes: 0.8 * gib,
			swapTotalBytes: 8 * gib,
			swapFreeBytes: 2 * gib,
			diskTotalBytes: 100 * gib,
			diskFreeBytes: 0.5 * gib,
		};
		expect(summarizeHostPressure(strained)).toEqual({
			psi: {
				cpu: { some10: 2.5, some60: 1.3 },
				memory: { some10: 31.2, some60: 12.1, full10: 9.9, full60: 4.4 },
				io: { some10: 0, some60: 0 },
			},
			memory_gib: { available: 0.8, total: 16 },
			swap_gib: { used: 6, total: 8 },
			disk_gib: { free: 0.5, total: 100 },
		});
		expect(hostStrain(strained)).toEqual(["memory pressure", "heavy swapping", "a nearly full disk"]);
		expect(
			hostStrain({
				...strained,
				memory: { some: { avg10: 0, avg60: 0 }, full: { avg10: 0, avg60: 0 } },
				memAvailableBytes: 12 * gib,
				swapFreeBytes: 8 * gib,
				diskFreeBytes: 60 * gib,
			}),
		).toEqual([]);
	});
});
