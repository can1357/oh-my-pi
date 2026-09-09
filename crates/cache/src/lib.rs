//! Reusable local caches and atomic persistence helpers.
//!
//! Session authority belongs to `omp-journal` and `omp-session`; this crate
//! contains only rebuildable or non-session cache data.

pub mod atomic;
pub mod backend;
/// User-wide document-conversion cache and daemon-owned collection policy.
pub mod document_cache;
/// Rebuildable direct-GitHub response cache.
pub mod github_cache;
/// Persistent MCP definition-cache storage.
pub mod mcp_cache;
/// Persistent secret-placeholder key storage.
pub mod secret_key;
/// Rebuildable historical usage index (`/stats`).
pub mod stats_cache;
/// Rebuildable diagnostic and AutoQA issue cache.
pub mod telemetry_cache;
