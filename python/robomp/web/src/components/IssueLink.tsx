import type { JSX } from "solid-js";

import { issueUrl, prUrl } from "../format";

export interface IssueLinkProps {
  repo: string;
  number: number | string;
}

export function IssueLink(props: IssueLinkProps): JSX.Element {
  return (
    <a
      class="font-mono text-[12px] text-ink-100 hover:text-accent-2"
      href={issueUrl(props.repo, props.number)}
      target="_blank"
      rel="noopener"
    >
      {props.repo}
      <span class="text-ink-400">#</span>
      {props.number}
    </a>
  );
}

export interface PrLinkProps {
  repo: string;
  number: number | string | null | undefined;
}

export function PrLink(props: PrLinkProps): JSX.Element {
  if (props.number == null || props.number === "") {
    return <span class="text-ink-400">—</span>;
  }
  return (
    <a
      class="font-mono text-[12px] text-accent-2 hover:underline"
      href={prUrl(props.repo, props.number)}
      target="_blank"
      rel="noopener"
    >
      #{props.number}
    </a>
  );
}
