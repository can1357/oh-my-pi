//! Descriptor-driven CCPA bridge. TLS profile conformance requires independent
//! negotiation and capture evidence; this crate does not assert attestation.
//!
//! `--serialize` uses the same embedded descriptor set as the Go helper.
//! Bridge mode publishes one `{port,token}` line, accepts authenticated local
//! HTTP requests, and shuts down when stdin closes. SSE continuations retain
//! checkpoint coverage and initial prompt/cache accounting; they do not retry
//! provider errors or replay output emitted after a checkpoint.
//!
//! `transport` is the wreq HTTP/TLS boundary and `tls` interprets the measured
//! ClientHello. The Go helper was the byte-level migration oracle, not a
//! fallback: the installed client now builds only this Rust transport. Native
//! roots are imported into BoringSSL; equal root sets do not establish native
//! OS certificate-chain policy equivalence.

pub mod bridge;
pub mod continuation;
mod protojson;
pub mod serialize;
pub mod tls;
pub mod transport;

pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T, E = Error> = std::result::Result<T, E>;

pub const CLIENT_HELLO: &[u8] = include_bytes!("../../agy-transport/clienthello.bin");
pub const CLIENT_PROFILE: &str = include_str!("../../agy-transport/profile.json");
