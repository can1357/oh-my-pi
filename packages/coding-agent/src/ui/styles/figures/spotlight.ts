/** The Spotlight notice (`text` role `omp.tool.spotlight`) is native-only: the terminal draws nothing. */
import { defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";

defineRolePainter("text", "omp.tool.spotlight", () => EMPTY_BLOCK);
