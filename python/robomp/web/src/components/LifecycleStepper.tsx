import { For, type JSX, Show } from "solid-js";

import {
  CODE_STAGES,
  SIMPLE_CLASSIFICATIONS,
  SIMPLE_STAGES,
  stageOrdinal,
} from "../work-items";

export interface LifecycleStepperProps {
  state: string | null;
  classification: string | null;
  failed: boolean;
  live: boolean;
}

type NodeState = "complete" | "current" | "failed" | "pending";

// Horizontal lifecycle track. Picks the 2-node "simple" path for non-code
// classifications (questions, enhancements, proposals) and the 5-node code
// path otherwise. State is carried entirely by data attributes so the CSS
// layer owns colour + the running pulse; this component stays dumb.
//
// Layout: equal-width cells (flex:1) so dot centres are evenly spaced; the
// connector for cell i is absolutely positioned from this dot's centre to the
// next dot's centre (one cell width), and the dot paints over it.
export function LifecycleStepper(props: LifecycleStepperProps): JSX.Element {
  const stages = (): readonly string[] =>
    props.classification != null && SIMPLE_CLASSIFICATIONS.has(props.classification)
      ? SIMPLE_STAGES
      : CODE_STAGES;
  const ord = (): number => stageOrdinal(props.state);

  const nodeState = (i: number): NodeState => {
    const o = ord();
    if (i < o) return "complete";
    if (i === o) return props.failed ? "failed" : "current";
    return "pending";
  };

  return (
    <div class="rmp-step">
      <For each={stages()}>
        {(stage, i) => (
          <div class="rmp-step-cell">
            <Show when={i() < stages().length - 1}>
              <div class="rmp-step-seg" data-state={i() < ord() ? "complete" : "pending"} />
            </Show>
            <div
              class="rmp-step-node"
              data-state={nodeState(i())}
              data-live={nodeState(i()) === "current" && props.live}
            />
            <span class="rmp-step-label" data-reached={i() <= ord()}>
              {stage}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}
