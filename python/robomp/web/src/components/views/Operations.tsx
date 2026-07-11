import { type JSX } from "solid-js";

import { Pipeline } from "../Pipeline";
import { Trigger } from "../Trigger";

// Operations (default landing view). A single unified pipeline: a slim
// trigger command row on top, then every active work item drawn as a
// lifecycle card (failed first, running live). Replaces the old three-table
// layout (working / needs-attention / active-issues) — Pipeline derives all
// three states from one status poll. Read-only collapses the trigger to a
// chip; the cards lose their retry/cancel actions.
export function Operations(): JSX.Element {
  return (
    <>
      <Trigger variant="bar" />
      <Pipeline />
    </>
  );
}
