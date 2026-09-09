//! Browser-compatible OMP collaboration wire, cryptography, replication, and
//! relay transport.

pub mod codec;
pub mod crypto;
pub mod host;
pub mod link;
pub mod presence;
pub mod relay;
pub mod replication;

/// The only protocol revision accepted by this crate.
pub const PROTOCOL_REVISION: u32 = 3;
