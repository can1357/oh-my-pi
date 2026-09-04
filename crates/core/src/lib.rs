#![feature(min_specialization)]
#![feature(core_intrinsics)]
#![feature(const_eval_select)]
#![feature(extend_one)]
#![feature(maybe_uninit_uninit_array_transpose)]
#![feature(type_alias_impl_trait)]
#![allow(
	internal_features,
	reason = "core_intrinsics is required for const_eval_select in encoding"
)]

//! Core data structures and utilities for `omp`.
/// Default User-Agent header sent by omp HTTP clients.
pub const USER_AGENT: &str = concat!("omp/", env!("CARGO_PKG_VERSION"));

pub mod append_vec;
pub mod cache;
pub mod cow_bytes;
/// Stable local and UTC display-time formatting.
pub mod dirs;
pub mod display_time;
pub mod encoding;
pub mod exclusive_sync;
pub mod fasthash;
/// Filesystem publication helpers.
pub mod fs;
pub mod hash32;
pub mod location;
pub mod logging;
pub mod open;
pub mod path;
pub mod phase;
pub mod principal;
pub mod qr;
pub mod secret;
pub mod semver;
/// Tolerant JSON for malformed, partial, and streaming documents.
pub mod slopjson;
pub mod sparse_index;
pub mod sparse_map;
pub mod sparse_set;
pub mod str;
/// Branded string identifier macro with default borrowed  query forms.
pub mod string_id;
pub mod time;
pub mod ulid;

pub use append_vec::{AppendSlice, AppendVec};
pub use cache::MemoCache;
pub use cow_bytes::CowBytes;
pub use display_time::{
	DisplayTimeError, local_calendar_date, local_minute_with_offset, utc_minute,
};
pub use encoding::{base32, base32_dns, base32_hex, base64, base64_url, hex};
pub use exclusive_sync::ExclusiveSync;
pub use fasthash::{FastHashMap, FastHashSet, FastState, fast_hash64};
pub use hash32::{Hash32, Hash32ParseError};
pub use location::{
	AgentUrl, ArtifactAddress, ArtifactUrl, ClientPath, EnvPath, HistoryUrl, LocationError,
	ToolPath, WorkspaceUri,
};
pub use path::{NormalizePath, shorten_home_path};
pub use phase::{ActivateReason, InvocationPhase, LifecyclePhase, Point, PointSet, RestartReason};
pub use principal::{
	ArtifactDigest, ArtifactDigestError, CredentialTier, Principal, Provenance, RemotePrincipal,
};
pub use qr::{QrCode, QrEc, QrOverflow};
pub use secret::{ExposeSecret, Secret, SecretBox, SecretString, ct_eq};
pub use semver::SemVer;
pub use sparse_map::SparseMap;
pub use sparse_set::SparseSet;
pub use str::{CowStr, IntoStr, Str, StrExt, StrMut};
pub use time::{Duration, DurationError, DurationUnit, format_rfc3339, parse_rfc3339};
pub use ulid::{Ulid, UlidParseError};
