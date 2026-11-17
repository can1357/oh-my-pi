import { register } from "../config/registry";

/** Backend for explicit analysis through read selectors and eval's dsm namespace; auto prefers idalib, then radare2. */
export const cfgDisassembler = register({
	id: "disassembler.backend",
	type: "enum",
	values: ["auto", "ghidra", "ida", "binja", "radare2", "none"] as const,
	default: "auto",
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Disassembler",
		description:
			"Backend for analysis selectors in read and eval's dsm namespace; bare executable reads show metadata only. Auto uses IDA Pro when installed, else radare2 when available, else Ghidra (downloaded on first analysis); Binary Ninja is used only when selected",
		options: [
			{
				value: "auto",
				label: "Auto",
				description: "IDA Pro when an install with idalib is found, otherwise radare2 when available, otherwise Ghidra; never Binary Ninja",
			},
			{
				value: "ghidra",
				label: "Ghidra",
				description:
					"Ghidra via PyGhidra; provisions Ghidra 12.2, a JDK 25 and PyGhidra on first analysis when not installed",
			},
			{
				value: "ida",
				label: "IDA Pro",
				description: "IDA Pro via idalib; analysis disabled when no install is found",
			},
			{
				value: "binja",
				label: "Binary Ninja",
				description:
					"Binary Ninja via its headless Python API (needs a headless-capable licence); never chosen by Auto; analysis disabled when no install is found",
			},
			{
				value: "radare2",
				label: "radare2",
				description:
					"radare2 via r2pipe; uses radare2 on PATH or radare2.r2Path, with r2pipe provisioned in a managed venv",
			},
			{ value: "none", label: "None", description: "Executable metadata only; analysis disabled" },
		],
	},
});

/** Maximum disassembler hosts per project; another open evicts the least recently used idle host. */
export const cfgDisasmMaxOpen = register({
	id: "disassembler.maxOpen",
	type: "number",
	default: 4,
	ui: {
		tab: "tools",
		group: "Disassembler",
		label: "Max Open Databases",
		description:
			"Most databases open at once per project (each is a disasm unit in omp ps, labelled with its backend and binary); opening another evicts an unreferenced idle one. Close retained dsm handles when done",
		options: [
			{ value: "2", label: "2" },
			{ value: "4", label: "4" },
			{ value: "8", label: "8" },
			{ value: "16", label: "16" },
		],
	},
});

/** Unreferenced idle seconds before a database saves and closes; zero disables idle-close. */
export const cfgDisasmIdleCloseSec = register({
	id: "disassembler.idleCloseSec",
	type: "number",
	default: 900,
	ui: {
		tab: "tools",
		group: "Disassembler",
		label: "Idle Close Timeout",
		description:
			"Save and close unreferenced databases idle longer than this many seconds (0 = never); retained dsm handles stay open. The exec namespace resets on reopen",
		options: [
			{ value: "0", label: "Never" },
			{ value: "300", label: "5 minutes" },
			{ value: "900", label: "15 minutes" },
			{ value: "1800", label: "30 minutes" },
			{ value: "3600", label: "1 hour" },
		],
	},
});
