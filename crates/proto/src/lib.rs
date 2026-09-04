//! Generated protobuf types for the workspace.
//!
//! `.proto` sources live in `proto/`; `build.rs` compiles them at build time
//! with protox + tonic-prost-build (no system `protoc` needed). Each protobuf
//! package maps to one module here — add an `include!` module when you add a
//! new package.
//!
//! Generated modules are transport bindings. Small hand-written modules hold
//! transport-neutral values that must remain identical across crate boundaries.
//! Message types are always available. Enable the `tonic` feature to also
//! generate gRPC clients and servers; pure-type consumers keep those runtime
//! dependencies out of their graph.
//!
//! Every generated type also derives `serde::{Serialize, Deserialize}` —
//! Rust-native serde (enums as ints, `snake_case` fields), not the proto3
//! JSON mapping.
//!
//! # Example
//!
//! ```
//! use omp_proto::{prost::Message, thread::v1::Revision};
//!
//! let rev = Revision { head: 42, token: b"chain".as_ref().into() };
//!
//! // Protobuf round-trip.
//! let bytes = rev.encode_to_vec();
//! assert_eq!(Revision::decode(&bytes[..]).unwrap(), rev);
//!
//! // Serde round-trip.
//! let json = serde_json::to_string(&rev).unwrap();
//! assert_eq!(serde_json::from_str::<Revision>(&json).unwrap(), rev);
//! ```

// Re-exported so consumers use the same `prost` the codegen targeted
// (the `Message` trait is needed for encode/decode).
pub use prost;
/// Allocation-free bounds checks for extension-facing protobuf frames.
pub mod bounds;
/// Serde adapters rendering protobuf byte fields as lossless text.
pub mod bytes_text;
/// LSP-compatible position, range, severity, and diagnostic value types shared
/// by the document authority and tools.
pub mod lsp;
/// JSON projections of `omp.inference.v1.Value` trees.
pub mod value_json;

/// Current wire-visible protobuf schema revision.
///
/// This is bumped for every wire-visible schema change and is the revision
/// compared by the `omp.gateway.v1.Hello` handshake.
pub const SCHEMA_REV: u32 = 18;

/// Generated packages under the protobuf `omp` namespace.
pub mod omp {
	/// Types generated from `omp.identity.v1`: shared durable wire identities.
	pub mod identity {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.identity.v1.rs"));
		}
	}

	/// Types generated from `omp.collab.v1`: encrypted collaboration relay
	/// frames.
	pub mod collab {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.collab.v1.rs"));
		}
	}
	/// Types generated from `omp.thread.v1`: the canonical conversation AST.
	pub mod thread {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.thread.v1.rs"));
		}
	}

	/// Types generated from `omp.inference.v1`: inference turns and facets.
	pub mod inference {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.inference.v1.rs"));
		}
	}

	/// Types generated from `omp.auth.v1`: authentication and credential flow.
	pub mod auth {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.auth.v1.rs"));
		}
	}

	/// Types generated from `omp.gateway.v1`: connection pre-flight negotiation.
	pub mod gateway {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.gateway.v1.rs"));
		}
	}

	/// Types generated from `omp.blob.v1`: content-addressed blob transfer.
	pub mod blob {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.blob.v1.rs"));
		}
	}

	/// Types generated from `omp.document.v1`: document transactions, native
	/// watch invalidation, and synchronized LSP passthrough.
	pub mod document {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.document.v1.rs"));
		}
	}

	/// Types generated from `omp.env.v1`: environment invocation, exec, and
	/// content-addressed blob planes.
	pub mod env {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.env.v1.rs"));
		}
	}

	/// Types generated from `omp.policy.v1`: portable policy facts and denials.
	pub mod policy {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.policy.v1.rs"));
		}
	}

	/// Types generated from `omp.ui.v1`: extension UI effects and dispatch.
	pub mod ui {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.ui.v1.rs"));
		}
	}

	/// Types generated from `omp.control.v1`: agents and durable control.
	pub mod control {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.control.v1.rs"));
		}
	}

	/// Types generated from `omp.telemetry.v1`: firehose events and sinks.
	pub mod telemetry {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.telemetry.v1.rs"));
		}
	}

	/// Types generated from `omp.toolhost.v1`: Python worker stdio protocol.
	pub mod toolhost {
		/// Version 1.
		pub mod v1 {
			#![allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions"
			)]
			#![allow(
				clippy::allow_attributes_without_reason,
				reason = "prost/tonic emits compatibility allow attributes without Rust reason \
				          metadata"
			)]
			#![allow(
				clippy::large_enum_variant,
				reason = "prost maps protobuf oneofs directly to enums; boxing would change the \
				          generated Rust API"
			)]
			include!(concat!(env!("OUT_DIR"), "/omp.toolhost.v1.rs"));
		}
	}
}

pub use omp::{
	auth, blob, collab, control, document, env, gateway, identity, inference, policy, telemetry,
	thread, toolhost, ui,
};
