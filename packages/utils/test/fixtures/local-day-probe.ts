/**
 * Exit-code probe for the local-day log naming contract, run as a child
 * process so the test can force `TZ` (see dirs.test.ts). Under a timezone
 * where the local day differs from the UTC day, `getLogPath` must still use
 * the local day even though `toISOString()` reports the UTC one.
 *
 * Exit codes: 0 = asserted; 1 = local-day regression; 2 = premise not met
 * (TZ not honored — the caller treats this as a skip).
 */
import { getLogPath, localDay } from "../../src/dirs";

const date = new Date(2026, 4, 31, 2, 30); // 02:30 local — previous UTC day in UTC+8
if (date.getTimezoneOffset() === 0 || localDay(date) === date.toISOString().slice(0, 10)) {
	process.exit(2);
}
const basename = getLogPath(date, 7).replace(/.*[/\\]/, "");
if (basename !== `omp.${localDay(date)}.7.log`) {
	console.error(`getLogPath used the UTC day key: ${basename}`);
	process.exit(1);
}
