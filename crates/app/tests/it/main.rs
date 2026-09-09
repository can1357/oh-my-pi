//! Consolidated omp-app integration harness; one binary links the embedded
//! `CPython` image once instead of once per test file.

#[cfg(unix)]
mod envd_contract;
#[cfg(unix)]
mod envd_documents;
mod envd_policy;
#[cfg(windows)]
mod envd_windows;
#[cfg(unix)]
mod envd_workspace;
mod process_smoke;
mod stock_sdk_clients;
#[cfg(unix)]
mod tool_worker;
#[cfg(windows)]
mod windows_named_pipe;
mod zz_sizes;
