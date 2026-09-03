import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";

function runCommand(command: string, args: string[]): string | null {
	try {
		const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return null;
		return result.stdout.toString("utf-8").trim();
	} catch {
		return null;
	}
}
/** Local N-API addon identity derived from a host platform and ISA. */
export interface LocalHostAddon {
	readonly filename: string;
	readonly x64Variant: "modern" | "baseline" | null;
}

/** Resolve the exact filename and x86-64 ISA emitted by the local N-API build. */
export function resolveLocalHostAddon(host: {
	readonly platform: string;
	readonly arch: string;
	readonly avx2: boolean;
}): LocalHostAddon {
	const x64Variant = host.arch === "x64" ? (host.avx2 ? "modern" : "baseline") : null;
	const variantSuffix = x64Variant ? `-${x64Variant}` : "";
	return {
		filename: `pi_natives.${host.platform}-${host.arch}${variantSuffix}.node`,
		x64Variant,
	};
}

/** Detect whether this x86-64 host can run the modern AVX2 addon. */
export function detectHostAvx2Support(): boolean {
	if (process.arch !== "x64") return false;

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {
		const leaf7 = runCommand("sysctl", ["-n", "machdep.cpu.leaf7_features"]);
		if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
		const features = runCommand("sysctl", ["-n", "machdep.cpu.features"]);
		return Boolean(features && /\bAVX2\b/i.test(features));
	}

	if (process.platform === "win32") {
		// `[System.Runtime.Intrinsics.X86.Avx2]` only exists on .NET Core, so the
		// PowerShell probe reported `false` on every host whose `powershell.exe`
		// is Windows PowerShell 5.1 (.NET Framework) — i.e. a stock Windows box —
		// silently downgrading AVX2 machines to the baseline ISA. Ask the kernel
		// instead: PF_AVX2_INSTRUCTIONS_AVAILABLE == 40.
		try {
			const kernel32 = dlopen("kernel32.dll", {
				IsProcessorFeaturePresent: { args: [FFIType.u32], returns: FFIType.i32 },
			});
			try {
				return kernel32.symbols.IsProcessorFeaturePresent(40) !== 0;
			} finally {
				kernel32.close();
			}
		} catch {
			return false;
		}
	}

	return false;
}
