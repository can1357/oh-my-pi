# omp-tool

`omp-tool` defines the typed, revisioned boundary between agent-side tool projection and environment-side execution.

Tools keep their parameter, update, payload, and fault types until registration. The registry erases those types once, retains pure prompt and revision-lift behavior for historical projection, and advertises only the live revision. Invocation arguments remain one linear streaming pull: raw fragments enter `omp_core::slopjson`, commitment is explicit, dropped feeds abort, and interrupts are observed without validating unpulled JSON keys.

The crate contains contracts and deterministic lowering only. Resource-owning executors belong behind the environment boundary.
