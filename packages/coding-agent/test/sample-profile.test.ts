import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import {
	demangleSymbol,
	parseSampleProfile,
	renderSampleProfile,
} from "@oh-my-pi/pi-coding-agent/utils/sample-profile";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const BOX_MEASURE = "_RNvNtCsfMEenOU8j5j_11slab_kernel6layout11box_measure";

/** Minimal but structurally faithful macOS `sample` report. */
const FIXTURE = [
	"Analysis of sampling demo (pid 42) every 1 millisecond",
	"Process:         demo [42]",
	"Path:            /tmp/demo",
	"Physical footprint:         10M",
	"Physical footprint (peak):  12M",
	"----",
	"",
	"Call graph:",
	"    100 Thread_1: main",
	"    + 100 start  (in dyld) + 8  [0x100]",
	"    +   100 run  (in demo) + 24  [0x200]",
	`    +     70 ${BOX_MEASURE}  (in demo) + 8  [0x300]`,
	`    +     ! 30 ${BOX_MEASURE}  (in demo) + 12,16,...  [0x301,0x302,...]`,
	"    +     !   10 memcpy  (in libsystem_platform.dylib) + 4  [0x400]",
	"    +     12 alloc  (in demo) + 8  [0x500]",
	"    +     8 alloc  (in demo) + 40  [0x510]",
	"    +     10 semaphore_wait_trap  (in libsystem_kernel.dylib) + 8  [0x600]",
	"    50 Thread_2: idler",
	"    + 50 thread_start  (in libsystem_pthread.dylib) + 8  [0x700]",
	"    +   50 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x800]",
	"",
	"Total number in stack (recursive counted multiple, when >=5):",
	"        70       something  (in demo) + 0  [0x300]",
	"",
	"Binary Images:",
	"       0x100 -        0x200 +demo (0) <UUID> /tmp/demo",
	"",
].join("\n");

describe("demangleSymbol", () => {
	it("extracts the path from Rust v0 symbols, skipping disambiguators and backrefs", () => {
		expect(demangleSymbol(BOX_MEASURE)).toBe("slab_kernel::layout::box_measure");
		expect(demangleSymbol("_RNvNtNtNtNtNtCslWr2rddMglm_4core3num3imp7flt2dec8strategy6dragon12format_exact")).toBe(
			"core::num::imp::flt2dec::strategy::dragon::format_exact",
		);
		// Backref (`B5_`) must not be misread as a length-prefixed identifier.
		expect(demangleSymbol("_RNvMs_NtCsaeZfelr0jAd_5alloc3vecINtB4_3VechE7reserveCscFRsxFFybUw_9addr2line")).toBe(
			"alloc::vec::Vec::reserve::addr2line",
		);
	});

	it("demangles legacy symbols and drops the trailing hash", () => {
		expect(demangleSymbol("_ZN4core3fmt9Formatter3pad17h1c9860dbd7c7fc47E")).toBe("core::fmt::Formatter::pad");
	});

	it("passes non-Rust symbols through unchanged", () => {
		expect(demangleSymbol("-[NSApplication run]")).toBe("-[NSApplication run]");
		expect(demangleSymbol("_platform_memmove")).toBe("_platform_memmove");
	});
});

describe("parseSampleProfile", () => {
	it("parses header, threads, and the decorated call tree", () => {
		const profile = parseSampleProfile(FIXTURE);
		expect(profile).not.toBeNull();
		expect(profile?.header).toMatchObject({ process: "demo", pid: 42, intervalMs: 1, path: "/tmp/demo" });
		expect(profile?.threads.map(t => ({ id: t.id, name: t.name, total: t.total }))).toEqual([
			{ id: "1", name: "main", total: 100 },
			{ id: "2", name: "idler", total: 50 },
		]);
		// start(100) → run(100) → [box_measure(70), alloc(12), alloc(8), wait(10)]
		const run = profile?.threads[0].roots[0].children[0];
		expect(run?.symbol).toBe("run");
		expect(run?.module).toBe("demo");
		expect(run?.children.map(c => c.count)).toEqual([70, 12, 8, 10]);
		// Multi-offset frame text (`+ 12,16,...  [0x301,0x302,...]`) parses to a bare symbol.
		expect(run?.children[0].children[0].symbol).toBe(BOX_MEASURE);
	});

	it("returns null for text that is not a sample report", () => {
		expect(parseSampleProfile("just some notes\nCall graph:\n")).toBeNull();
		expect(parseSampleProfile("")).toBeNull();
	});
});

describe("renderSampleProfile", () => {
	const rendered = renderSampleProfile(FIXTURE);
	if (rendered === null) throw new Error("fixture must render");

	it("reports on-CPU samples with blocked time excluded", () => {
		// Thread 1: 100 samples minus 10 in semaphore_wait_trap.
		expect(rendered).toContain("main (Thread_1) — 100 samples, 90 on-CPU (90.0%)");
	});

	it("classifies fully blocked threads as idle with their dominant wait", () => {
		expect(rendered).toContain("idler (Thread_2): blocked in mach_msg2_trap (0 on-CPU)");
		expect(rendered).not.toContain("## idler");
	});

	it("flattens direct recursion and demangles symbols in hot paths", () => {
		expect(rendered).toContain("slab_kernel::layout::box_measure [recursive ×2]");
		expect(rendered).not.toContain(BOX_MEASURE);
	});

	it("merges same-symbol siblings split by call-site offset", () => {
		// alloc appears twice (12 + 8) in the report but once, merged, in the hot-path tree.
		const tree = rendered.slice(0, rendered.indexOf("## Idle"));
		const allocLines = tree.split("\n").filter(line => line.includes("alloc"));
		expect(allocLines.filter(line => /^\s*20\b/.test(line))).toHaveLength(1);
	});

	it("ranks top functions by self samples, excluding wait syscalls", () => {
		const section = rendered.slice(rendered.indexOf("## Top functions"));
		const order = ["slab_kernel::layout::box_measure", "alloc", "memcpy"].map(sym => section.indexOf(sym));
		expect(Math.min(...order)).toBeGreaterThan(0);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(section).not.toContain("semaphore_wait_trap");
		expect(section).not.toContain("mach_msg2_trap");
	});
});

describe("read tool .sample.txt dispatch", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sample-profile-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function createSession(cwd: string): ToolSession {
		return {
			cwd,
			hasUI: false,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(cwd, "artifacts"),
			allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
			settings: Settings.isolated(),
		};
	}

	function textOutput(result: AgentToolResult<ReadToolDetails>): string {
		return result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}

	it("summarizes sample reports, with :raw as the verbatim escape hatch", async () => {
		const filePath = path.join(tmpDir, "demo-42.sample.txt");
		await fs.writeFile(filePath, FIXTURE);

		const tool = new ReadTool(createSession(tmpDir));
		const summary = textOutput(await tool.execute("read-sample", { path: filePath }));
		expect(summary).toContain("macOS sample profile: demo (pid 42)");
		expect(summary).toContain("slab_kernel::layout::box_measure");
		expect(summary).not.toContain(BOX_MEASURE);

		const raw = textOutput(await tool.execute("read-sample-raw", { path: `${filePath}:raw` }));
		expect(raw).toContain("Call graph:");
		expect(raw).toContain(BOX_MEASURE);
	});

	it("falls back to plain text when a .sample.txt file is not a sample report", async () => {
		const filePath = path.join(tmpDir, "notes.sample.txt");
		await fs.writeFile(filePath, "these are just notes\nsecond line\n");

		const tool = new ReadTool(createSession(tmpDir));
		const output = textOutput(await tool.execute("read-notes", { path: filePath }));
		expect(output).toContain("these are just notes");
	});
});
