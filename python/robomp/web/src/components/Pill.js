export function Pill(props) {
    const className = () => {
        const parts = ["pill"];
        if (props.state)
            parts.push(props.state);
        if (props.dot)
            parts.push("dot");
        if (props.class)
            parts.push(props.class);
        return parts.join(" ");
    };
    return (<span class={className()} title={props.title}>
      {props.children}
    </span>);
}
