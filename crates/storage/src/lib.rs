//! Session storage: the content-addressed blob store and the transcript v4
//! append-only event log (see `TRANSCRIPT-V4.md` at the repo root).
//!
//! Two invariants rule everything here:
//! - **Append-only**: nothing written is ever edited; after-the-fact state is
//!   later events referencing earlier indexes.
//! - **Every byte exists in exactly one place**: neutral projections live in
//!   blocks, provider-native residue lives in replay capsules, large payloads
//!   live in the blob store behind typed [`blob::BlobRef`]s.

pub mod analytics;
pub mod atomic;
pub mod backend;
pub mod blob;
/// User-wide document-conversion cache and daemon-owned collection policy.
pub mod document_cache;
pub mod gc;
/// Rebuildable direct-GitHub response cache.
pub mod github_cache;
pub mod index;
/// Collision-aware session-index archive and lineage operations.
pub mod maintenance;
/// Persistent MCP definition-cache storage.
pub mod mcp_cache;
/// Persistent secret-placeholder key storage.
pub mod secret_key;
pub mod state;
/// Consent-gated prompt-free statistics storage.
pub mod stats_db;
/// Incremental background transcript statistics ingestion.
pub mod stats_ingest;
pub mod telemetry_index;
pub mod testing;
pub mod transcript;
