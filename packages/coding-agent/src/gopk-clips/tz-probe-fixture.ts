/**
 * Child-process fixture for the timezone-dependent assertions in read.test.ts.
 *
 * The local-time logic in ./read.ts is a function of the *process* timezone,
 * and a process timezone cannot be changed twice: Bun applies the first
 * `process.env.TZ` assignment and then ignores both `delete` and any later
 * re-assignment, so a test that sets TZ in-process re-zones every sibling suite
 * sharing its `bun test` process for the rest of the run — irreversibly, and
 * invisibly, since reading `process.env.TZ` back reports the restored value
 * while `Date` stays on the leaked zone.
 *
 * So the zone is set where it is safe to set it: in a child's environment.
 * This script measures one calendar day under whatever TZ it inherits and
 * prints the result as JSON.
 *
 * Usage: TZ=America/New_York bun tz-probe-fixture.ts 2026-03-08
 */
import { floorToLocalHour, localDayWindow, localHourStarts } from "./read";

const date = process.argv[2];
if (!date) {
	process.stderr.write("usage: tz-probe-fixture.ts <YYYY-MM-DD>\n");
	process.exit(2);
}

const window = localDayWindow(date);
const starts = localHourStarts(window);

process.stdout.write(
	JSON.stringify({
		zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		/** Length of the local calendar day: 23, 24, or 25 across a DST shift. */
		dayHours: (window.endedAt - window.startedAt) / 3_600_000,
		markCount: starts.length,
		/** Local hour label of each bucket; a fall-back day repeats one. */
		labels: starts.map(at => new Date(at).getHours()),
		/** Minute-of-hour each mark lands on. Non-zero means a mislabelled bucket. */
		markMinutes: [...new Set(starts.map(at => new Date(at).getMinutes()))],
		/** floorToLocalHour must be idempotent on a value that is already a mark. */
		marksAreFixpoints: starts.every(at => floorToLocalHour(at) === at),
		/** No mark may precede the window it covers (a DST-gap hazard). */
		firstMarkCoversStart: starts.length > 0 && (starts[0] as number) <= window.startedAt,
	}),
);
