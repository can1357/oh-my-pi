# omp-sdk

`omp-sdk` is the thin native embedding boundary for the journal-first OMP
kernel. `Sdk::create` and `Sdk::open` pair a caller-composed `omp_agent::Kernel`
with an authoritative `omp_session::Session`; `submit` runs one durable turn,
and `subscribe` gives actors a detached DOM snapshot plus its event stream.

The facade intentionally does not duplicate production composition, settings,
callbacks, provider routing, or UI state. Applications that need the complete
stack obtain their kernel from `omp-driver` and then use the same session and
actor contracts exposed here.
