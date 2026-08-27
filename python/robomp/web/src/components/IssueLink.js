import { issueUrl, prUrl } from "../format";
export function IssueLink(props) {
    return (<a class="font-mono text-[12px] text-ink-100 hover:text-accent-2" href={issueUrl(props.repo, props.number)} target="_blank" rel="noopener">
      {props.repo}
      <span class="text-ink-400">#</span>
      {props.number}
    </a>);
}
export function PrLink(props) {
    if (props.number == null || props.number === "") {
        return <span class="text-ink-400">—</span>;
    }
    return (<a class="font-mono text-[12px] text-accent-2 hover:underline" href={prUrl(props.repo, props.number)} target="_blank" rel="noopener">
      #{props.number}
    </a>);
}
