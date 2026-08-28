/**
 * Aggregated sample data for the `omp gallery` command.
 *
 * Each fixture drives one tool's renderer through the four lifecycle states the
 * gallery showcases: arguments streaming in, arguments complete but awaiting a
 * result, a successful result, and a failed result. The data is intentionally
 * hand-written (rather than schema-derived) so the gallery reflects what a real
 * tool call looks like — the whole point is visual QA of the renderers.
 *
 * Fixtures are grouped by subsystem into sibling modules and merged here.
 * Adding a tool to one of those groups is enough for the gallery to render it.
 * Tools present in the renderer registry but missing here fall back to a
 * generic fixture (see `gallery-cli.ts`), so the gallery never crashes on a
 * newly added tool — it just looks plain until a fixture is supplied.
 */
import { agenticFixtures } from "./agentic";
import { codeintelFixtures } from "./codeintel";
import { editFixtures } from "./edit";
import { fsFixtures } from "./fs";
import { interactionFixtures } from "./interaction";
import { memoryFixtures } from "./memory";
import { miscFixtures } from "./misc";
import { searchFixtures } from "./search";
import { shellFixtures } from "./shell";
import { statusLineFixtures } from "./status-line";
import { webFixtures } from "./web";

export * from "./types";

export const galleryFixtures = {
	...interactionFixtures,
	...shellFixtures,
	...fsFixtures,
	...searchFixtures,
	...editFixtures,
	...agenticFixtures,
	...memoryFixtures,
	...webFixtures,
	...codeintelFixtures,
	...statusLineFixtures,
	...miscFixtures,
};
