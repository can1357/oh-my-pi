const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** Human-readable size in powers of 1024, labelled with IEC units. */
export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}
