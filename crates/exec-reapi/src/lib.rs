//! Remote Execution API v2 backend for [`omp_exec`] (ADR 0040, Slice 1 PR 1b).
//!
//! The crate speaks the standard REAPI over gRPC. Anything specific to one
//! service (the API-key header, platform property names, isolation properties)
//! is profile data supplied by the composing crate. Cancel uses the standard
//! `Operations.CancelOperation` RPC; until a Delegated cancel fallback lands,
//! services that leave that RPC unimplemented are bounded by the action
//! timeout.

pub mod capabilities;
pub mod cas;
pub mod digest;
pub mod endpoint;
mod execute;
pub mod profile;
pub mod status;
pub mod tree;

/// The execution backend and its profile-driven configuration.
pub use execute::{Config as ExecuteConfig, ReapiBackend, ReapiRun, Toolchain};

/// Generated bindings for the vendored protos.
///
/// The module tree mirrors the protobuf package tree on purpose: prost emits
/// cross-package references as `super::super::...::google::rpc::Status`, so
/// `build` and `google` must be siblings under this module for those paths to
/// resolve.
pub mod proto {
	/// Declares the module holding the generated file for one protobuf
	/// package, with the lint relaxations machine-generated code needs.
	macro_rules! package {
		($(#[$meta:meta])* $name:ident, $root:literal, $file:literal) => {
			$(#[$meta])*
			#[allow(
				missing_docs,
				clippy::pedantic,
				clippy::nursery,
				clippy::allow_attributes_without_reason,
				clippy::large_enum_variant,
				reason = "prost/tonic output is machine-generated and cannot follow handwritten \
				          documentation and style conventions; boxing oneofs would change the \
				          generated API"
			)]
			pub mod $name {
				include!(concat!(env!("OUT_DIR"), "/", $root, "/", $file));
			}
		};
		($(#[$meta:meta])* $name:ident, $file:literal) => {
			package! { $(#[$meta])* $name, "proto", $file }
		};
	}

	/// Packages under `build`.
	pub mod build {
		/// Packages under `build.bazel`.
		pub mod bazel {
			package! {
				/// `build.bazel.semver`.
				semver, "build.bazel.semver.rs"
			}
			/// Packages under `build.bazel.remote`.
			pub mod remote {
				/// Packages under `build.bazel.remote.execution`.
				pub mod execution {
					package! {
						/// `build.bazel.remote.execution.v2`: CAS, action cache,
						/// execution and capabilities.
						v2, "build.bazel.remote.execution.v2.rs"
					}
				}
			}
		}
	}

	/// Packages under `google`.
	pub mod google {
		package! {
			/// `google.api`.
			api, "google.api.rs"
		}
		package! {
			/// `google.bytestream`.
			bytestream, "google.bytestream.rs"
		}
		package! {
			/// `google.longrunning`.
			longrunning, "google.longrunning.rs"
		}
		package! {
			/// `google.rpc`.
			rpc, "google.rpc.rs"
		}
	}
}
