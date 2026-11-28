// Replaces the file-backed loader only in linked standalone builds.
export const embeddedAddon = null;

/** Register this executable's native exports in the current VM. loadNative caches the resulting classes. */
export function openLinkedAddon() {
	const module = { exports: {} };
	process.dlopen(module, process.platform === "linux" ? "/proc/self/exe" : process.execPath);
	return module.exports;
}
