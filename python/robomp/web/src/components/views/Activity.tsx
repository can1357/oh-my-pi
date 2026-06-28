import { type JSX, Show } from "solid-js";

import { runTrigger, triggerStatus } from "../../state";
import { Events } from "../Events";
import { Logs } from "../Logs";

const STATUS_TONE = {
  idle: "text-ink-400",
  pending: "text-ink-200",
  ok: "text-ok",
  err: "text-err",
} as const;

// Activity (investigate mode). Full history table + full-height log stream.
// Logs finally get real vertical room. The shared trigger status renders right
// under the events table so a retry fired from this view surfaces its
// success/error where the button was clicked — the Trigger bar lives only on
// Operations/Triage, so without this the Activity retry feedback is invisible.
export function Activity(): JSX.Element {
  const handleRetry = (deliveryId: string): void => {
    void runTrigger({ mode: "retry", delivery_id: deliveryId });
  };

  return (
    <>
      <Events onRetry={handleRetry} />
      <Show when={triggerStatus().text}>
        <span
          class={`rmp-activity-status ${STATUS_TONE[triggerStatus().kind]}`}
          role={triggerStatus().kind === "err" ? "alert" : "status"}
        >
          {triggerStatus().text}
        </span>
      </Show>
      <Logs />
    </>
  );
}
