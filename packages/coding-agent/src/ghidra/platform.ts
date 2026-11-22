/** Whether a host has a supported Ghidra/JDK platform; installation is lazy. */
export function ghidraHostSupported(
	platform: NodeJS.Platform = process.platform,
	arch: NodeJS.Architecture = process.arch,
): boolean {
	return (
		((platform === "darwin" || platform === "linux") && (arch === "arm64" || arch === "x64")) ||
		(platform === "win32" && arch === "x64")
	);
}

/** Distribution directory name for the current host's Ghidra native executables. */
export function ghidraNativesPlatform(): string {
	if (!ghidraHostSupported()) throw new Error(`Ghidra does not support ${process.platform}/${process.arch}`);
	const os = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
	return `${os}_${process.arch === "arm64" ? "arm_64" : "x86_64"}`;
}
