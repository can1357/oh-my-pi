import type { JSX } from "solid-js";

export interface PillProps {
  state?: string;
  dot?: boolean;
  title?: string;
  class?: string;
  children?: JSX.Element;
}

export function Pill(props: PillProps): JSX.Element {
  const className = (): string => {
    const parts = ["pill"];
    if (props.state) parts.push(props.state);
    if (props.dot) parts.push("dot");
    if (props.class) parts.push(props.class);
    return parts.join(" ");
  };
  return (
    <span class={className()} title={props.title}>
      {props.children}
    </span>
  );
}
