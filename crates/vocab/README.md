# `omp-vocab`

`omp-vocab` is the shared, closed vocabulary for the durable session tree and the typed terminal component surface. Structural tags and engine-owned property names are enums; tool element and property names remain explicit custom values.

The existing `for_each_prop!` and `for_each_component!` row sources remain the single source used by `omp-tui` and `omp-macros`, while `KnownTag`, `Tag`, `PropId`, and `PropKey` define the session-DOM vocabulary without coupling the DOM to presentation code.
