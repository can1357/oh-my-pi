//! Authoritative materialized session tree, atomic patch application, and
//! subscriptions.

mod arena;
mod node;
mod op;
mod selector;
mod snapshot;
mod stream;
mod subscribe;
mod txn;

pub use arena::Handle;
pub use node::{Node, NodeSpec, Value};
pub use omp_vocab::{KnownTag, PropId, PropKey, Tag};
pub use op::{Op, StreamOp};
pub use selector::SelectorError;
pub use snapshot::{Snapshot, SnapshotDecodeError};
pub use stream::Sid;
pub use subscribe::{Event, Patch};
pub use txn::{Applied, Dom, DomError, Txn};
