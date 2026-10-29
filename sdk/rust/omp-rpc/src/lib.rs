//! Rust client for the omp RPC protocol: JSON lines over the stdio of `omp
//! --mode rpc`.
//!
//! [`wire`] is generated from the wire schema by `bun run gen:rpc`; [`client`]
//! is a blocking transport (protocol v2 chunking, prompt waits, host tools,
//! host URIs).

#[rustfmt::skip]
pub mod wire;
pub mod client;
mod frame;
pub mod host_tool;
pub mod host_uri;
pub mod turn;

pub use client::{Client, ClientOptions, DEFAULT_PROMPT_TIMEOUT, Error, Event, encode_command};
pub use host_tool::{HostTool, HostToolContext, HostToolError, HostToolOutput};
pub use host_uri::{HostUri, HostUriContext, HostUriError, HostUriRead};
pub use turn::PromptTurn;
pub use wire::*;
