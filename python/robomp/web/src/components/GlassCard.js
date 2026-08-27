// Single glass surface used for every section card. The `bare` variant skips
// the inset content padding so tables/log lists can reach the edge.
export function GlassCard(props) {
    const cls = () => {
        const base = "glass glass-rise rounded-lg overflow-hidden";
        return props.class ? `${base} ${props.class}` : base;
    };
    return (<section class={cls()} style={props.style}>
      {props.heading != null && (<div class="section-heading">
          <h2>{props.heading}</h2>
          {props.accessory && <div class="accessory">{props.accessory}</div>}
        </div>)}
      <div class={props.contentClass}>{props.children}</div>
    </section>);
}
