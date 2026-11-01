/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { effect, register } from "../config/registry";
import { SUPERSEDED_KERNEL_GRACE_MS, setSupersededKernelGraceMs } from "./superseded-reclaim";

// Eval (per-backend toggles; add more as new backends ship, e.g. eval.ts)
export const cfgEvalPy = register({
	id: "eval.py",
	type: "boolean",
	default: true,
	env: "PI_PY",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Python Eval Backend",
		description: "Allow the eval tool to dispatch Python cells to the IPython kernel",
	},
});

export const cfgEvalJs = register({
	id: "eval.js",
	type: "boolean",
	default: true,
	env: "PI_JS",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "JavaScript Eval Backend",
		description: "Allow the eval tool to dispatch JavaScript cells to the in-process runtime",
	},
});

export const cfgEvalAutoProvision = register({
	id: "eval.autoProvision",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Eval Environment Provisioning",
		description: "Automatically create the managed JavaScript eval package environment on first install",
	},
});

export const cfgEvalToolsEnabled = register({
	id: "eval.tools.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Eval-Defined Tools",
		description:
			"Let eval cells define tools (@tool in Python, tool(fn) in JS) that task, agent(), and workpool() subagents can call",
	},
});

export const cfgEvalWorkpoolFreshAgents = register({
	id: "eval.workpool.freshAgents",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Fresh Workpool Agents",
		description: "Spawn a new subagent for every workpool item instead of reusing workers or batching queued items",
	},
});

export const cfgEvalAutoBackgroundEnabled = register({
	id: "eval.autoBackground.enabled",
	protocolDefault: ["rpc"],
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Eval Auto-Background",
		description: "Automatically background long-running eval cells and deliver the result later",
	},
});

export const cfgEvalAutoBackgroundThresholdMs = register({
	id: "eval.autoBackground.thresholdMs",
	protocolDefault: ["rpc"],
	type: "number",
	default: 60_000,
});

/**
 * How long a retained Python kernel or JavaScript worker outlives the moment
 * every session using it has run its latest cell somewhere else. Process-wide:
 * the kernel registries are, and a kernel can be shared by several sessions.
 * Any finite non-negative value is honoured: one longer than a platform timer
 * can hold (about 24.8 days) is waited out in several timers, not cut short.
 */
export const cfgEvalKernelReclaimGraceMs = register({
	id: "eval.kernelReclaimGraceMs",
	type: "number",
	default: SUPERSEDED_KERNEL_GRACE_MS,
	validate: raw => {
		if (raw === undefined || raw === null) return;
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
			throw new Error(
				"eval.kernelReclaimGraceMs must be a finite non-negative number of milliseconds (0 never reclaims; there is no upper limit)",
			);
		}
	},
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Left-Behind Kernel Grace",
		description:
			"How long a Python kernel or JavaScript worker is kept after every session using it has run its latest cell in another directory, session file or interpreter. Then it is shut down and its variables, imports and definitions are lost; the next cell there says so. The shutdown also stops work its cells left running — Python threads and subprocesses in the kernel's process group, JavaScript timers, callbacks and background threads — and loses writes not yet flushed, except that a subprocess in its own session or process group can keep running, and a thread blocked in uninterruptible I/O outlives the kill until that I/O completes or is aborted. Set to 0 to keep it until the session ends.",
		options: [
			{ value: "0", label: "Never", description: "Keep every kernel until its session ends" },
			{ value: "30000", label: "30 seconds" },
			{ value: "120000", label: "2 minutes", description: "Default" },
			{ value: "600000", label: "10 minutes" },
			{ value: "1800000", label: "30 minutes" },
		],
	},
});
effect(cfgEvalKernelReclaimGraceMs, setSupersededKernelGraceMs);

// Runtime knobs (consumed by eval backends and the /python slash command)
export const cfgPythonKernelMode = register({
	id: "python.kernelMode",
	type: "enum",
	values: ["session", "per-call"] as const,
	default: "session",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Python Kernel Mode",
		description: "Keep the IPython kernel alive across eval calls or start fresh each time",
	},
});

export const cfgPythonInterpreter = register({
	id: "python.interpreter",
	type: "string",
	default: "",
	ui: {
		tab: "shell",
		group: "Eval & Runtimes",
		label: "Python Interpreter",
		description:
			"Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.",
	},
});
