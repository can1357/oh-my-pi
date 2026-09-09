# omp-observability

`omp-observability` provides OpenTelemetry instrumentation for OMP's agent loop. It preserves the established telemetry wire contract, including span names, attribute keys, metric instruments, log-record shapes, environment-variable controls, and the `omp.gen_ai.*` and `omp.*` extensions.

## Structure

- `attrs` and `semconv` define the telemetry vocabulary, span names, enum values, and provider normalization.
- `span` and `content` manage span lifecycles and policy-bounded, always-masked content capture.
- `metrics` and `collector` define instruments and aggregate data for each run.
- `logging` installs tracing, writes rotating JSON logs, and exposes startup timing.
- `config`, `export`, and `redact` handle configuration, OTLP setup, and sensitive-data scrubbing.

## Runtime logging

OMP installs the subscriber before hidden child dispatch. `OMP_LOG` filters the
rotating JSON file log, `OMP_LOG_STDERR` enables filtered stderr echo, and
`OMP_TIMING=1` adds span-close timings to stderr. `OMP_TIMING=exit` profiles
interactive startup and exits before the UI.

Per-process logs live under the native state directory's `logs` subdirectory.
Each dated file rotates at 10 MiB and retains five files for that process.

## Philosophy

Wire compatibility is the primary constraint: existing collectors, dashboards, and alerts should continue to work across the Rust rewrite. The crate keeps vocabulary, instrumentation, aggregation, export, and redaction in distinct modules, and content capture remains explicit rather than automatic.
