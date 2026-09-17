import { type JSX, Show } from "solid-js";

import { CONFIG } from "../../config";
import { Browse } from "../Browse";
import { GlassCard } from "../GlassCard";
import { Trigger } from "../Trigger";

// Triage (act mode). Full trigger form + issue browser. When replay is off,
// renders ONE composed first-run panel (env + what unlocks) instead of two
// large disabled cards. The rail marks this nav item locked + dimmed.
export function Triage(): JSX.Element {
  return (
    <Show
      when={CONFIG.replayEnabled}
      fallback={<FirstRunPanel />}
    >
      <Trigger variant="panel" />
      <Browse />
    </Show>
  );
}

function FirstRunPanel(): JSX.Element {
  return (
    <GlassCard heading="triage" accessory={<span class="rmp-readonly-chip">locked</span>}>
      <div class="rmp-firstrun">
        <div class="rmp-firstrun-head">
          <span class="rmp-readonly-chip">read-only</span>
          <h3 class="rmp-firstrun-title">manual actions are disabled</h3>
        </div>
        <p class="rmp-firstrun-body">
          Triage and retry let you drive the bot by hand — fetch a fresh issue, re-run a failed
          delivery, or browse the open backlog. These actions are gated behind a server-side
          replay token so the dashboard is safe to expose read-only.
        </p>
        <ul class="rmp-firstrun-steps">
          <li>
            set <code>ROBOMP_REPLAY_TOKEN</code> in the robomp server environment
          </li>
          <li>restart the server so the token is loaded</li>
          <li>reload — the Operations trigger bar and this Triage view unlock</li>
        </ul>
        <p class="rmp-firstrun-note">
          Monitoring stays fully live: Operations and Activity read the same 3s poll regardless of
          this setting.
        </p>
      </div>
    </GlassCard>
  );
}
