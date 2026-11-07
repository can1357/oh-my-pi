/**
 * Entry-module evaluation probe for the boot-lazy boundary test.
 *
 * Imports `main.ts` and nothing else. `main.ts` has no top-level invocation, so
 * this evaluates exactly the module graph a launch builds before `main()` runs
 * — the graph the first-use boundaries are supposed to shrink — without
 * reaching into argument parsing, provider setup, or the TUI.
 */
import "../../src/main";
import { writeBootModuleReport } from "./boot-module-load-recorder";

writeBootModuleReport();
