import { For, type JSX, Show } from "solid-js";

import { fmtAge, shortText } from "../format";
import { statusResource } from "../state";
import type { ReleaseRow, ReleaseState } from "../types";
import { GlassCard } from "./GlassCard";
import { Pill } from "./Pill";

const PILL_STATE: Record<ReleaseState, string> = {
  awaiting_ci: "queued",
  fixing: "running",
  green: "done",
  failed: "failed",
  superseded: "skipped",
};

/** Displays durable release-sentinel rounds and terminal outcomes. */
export function Releases(): JSX.Element {
  const releases = (): ReleaseRow[] => statusResource()?.releases ?? [];

  return (
    <GlassCard heading="releases" accessory={<span class="tabular">{releases().length}</span>}>
      <Show when={releases().length} fallback={<div class="empty">no releases recorded yet</div>}>
        <div class="overflow-x-auto scrollable">
          <table class="t">
            <thead>
              <tr>
                <th>release</th>
                <th>state</th>
                <th>rounds</th>
                <th>current SHA</th>
                <th>updated</th>
                <th>error</th>
              </tr>
            </thead>
            <tbody>
              <For each={releases()}>{(release) => <ReleaseTableRow release={release} />}</For>
            </tbody>
          </table>
        </div>
      </Show>
    </GlassCard>
  );
}

interface ReleaseTableRowProps {
  release: ReleaseRow;
}

function ReleaseTableRow(props: ReleaseTableRowProps): JSX.Element {
  const releaseUrl = (): string =>
    `https://github.com/${props.release.repo}/releases/tag/${encodeURIComponent(props.release.tag)}`;

  return (
    <tr>
      <td>
        <a
          class="font-mono text-[12px] text-ink-100 hover:text-accent-2"
          href={releaseUrl()}
          target="_blank"
          rel="noopener"
        >
          {props.release.key}
        </a>
      </td>
      <td>
        <Pill state={PILL_STATE[props.release.state]}>{props.release.state}</Pill>
      </td>
      <td class="text-ink-300 tabular">{props.release.rounds}</td>
      <td>
        <code title={props.release.current_sha}>{props.release.current_sha.slice(0, 12)}</code>
      </td>
      <td class="text-ink-300 tabular whitespace-nowrap">{fmtAge(props.release.updated_at)}</td>
      <td class="err-cell" title={props.release.last_error ?? ""}>
        {shortText(props.release.last_error, 200)}
      </td>
    </tr>
  );
}
