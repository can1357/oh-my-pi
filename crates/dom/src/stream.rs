use omp_core::{Str, StrMut};
use serde::{Deserialize, Serialize};

use crate::{Handle, PropKey};

/// Identity of an append-only text stream.
pub type Sid = u32;

#[derive(Clone)]
pub struct OpenStream {
	pub(crate) node:           Handle,
	pub(crate) prop:           PropKey,
	pub(crate) text:           StrMut,
	pub(crate) appended_bytes: usize,
}

/// Serializable stream metadata used by snapshots.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SnapshotStream {
	pub(crate) sid:            Sid,
	pub(crate) node:           Handle,
	pub(crate) prop:           PropKey,
	pub(crate) text:           Str,
	pub(crate) appended_bytes: usize,
}
