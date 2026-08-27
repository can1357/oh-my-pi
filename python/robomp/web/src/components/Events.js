import { For, Show } from "solid-js";
import { CONFIG } from "../config";
import { fmtAge, splitIssueKey } from "../format";
import { statusResource } from "../state";
import { GlassCard } from "./GlassCard";
import { IssueLink } from "./IssueLink";
import { Pill } from "./Pill";
export function Events(props) {
    const events = () => statusResource()?.recent_events ?? [];
    return (<GlassCard heading="recent events" accessory={<span class="tabular">{events().length}</span>}>
      <Show when={events().length} fallback={<div class="empty">no events recorded yet</div>}>
        <div class="overflow-x-auto scrollable">
          <table class="t">
            <thead>
              <tr>
                <th>received</th>
                <th>event</th>
                <th>where</th>
                <th>state</th>
                <th>tries</th>
                <th>error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={events()}>
                {(event) => <EventRow event={event} onRetry={props.onRetry}/>}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </GlassCard>);
}
function EventRow(props) {
    const ref = () => splitIssueKey(props.event.issue_key);
    const canRetry = () => props.event.state === "failed" || props.event.state === "done";
    return (<tr>
      <td class="text-ink-300 tabular whitespace-nowrap">{fmtAge(props.event.received_at)}</td>
      <td class="text-ink-200">{props.event.event_type}</td>
      <td>
        <Show when={ref().number} fallback={<span class="text-ink-300">{props.event.repo ?? "—"}</span>}>
          <IssueLink repo={ref().repo} number={ref().number}/>
        </Show>
      </td>
      <td>
        <Pill state={props.event.state}>{props.event.state}</Pill>
      </td>
      <td class="text-ink-300 tabular">{props.event.attempts}</td>
      <td class="err-cell">{props.event.last_error ?? ""}</td>
      <td>
        <Show when={CONFIG.replayEnabled && canRetry()} fallback={<span class="text-ink-400">—</span>}>
          <button class="tiny" onClick={() => props.onRetry(props.event.delivery_id)}>
            retry
          </button>
        </Show>
      </td>
    </tr>);
}
