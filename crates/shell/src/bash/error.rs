//! Errors of the shell lifecycle calls.

use bstr::BString;

use crate::bash::{ids::UnitId, signal::Signal, store::StoreError};

/// Failure of [`Shell::create`](crate::bash::Shell::create).
#[derive(Debug, thiserror::Error)]
pub enum ShellError {
	/// Writing the initial root state failed.
	#[error("could not write the initial shell state")]
	Store(#[from] StoreError),
	/// `ShellInit::options` names an option bash does not have.
	#[error("{name}: invalid option name")]
	UnknownOption {
		/// The name.
		name: BString,
	},
}

/// Failure of [`Shell::restore`](crate::bash::Shell::restore).
#[derive(Debug, thiserror::Error)]
pub enum RestoreError {
	/// The store failed.
	#[error("could not read the shell state")]
	Store(#[from] StoreError),
	/// The frames blob was written by another engine build or IR version;
	/// retry with `RestoreOpts { drop_frames: true }`.
	#[error("frames blob is incompatible with this engine ({why})")]
	Incompatible {
		/// Which check failed.
		why: Incompatibility,
	},
	/// The frames blob does not decode.
	#[error("frames blob is corrupt")]
	Corrupt(#[source] postcard::Error),
	/// A unit referenced by the frames is missing from the store.
	#[error("unit {unit} referenced by the frames is missing")]
	MissingUnit {
		/// The unit.
		unit: UnitId,
	},
	/// A unit or frame references code or tables out of range.
	#[error("unit {unit} is inconsistent with its frames")]
	InvalidUnit {
		/// The unit.
		unit: UnitId,
	},
	/// A unit blob does not decode.
	#[error("unit {unit} is corrupt")]
	CorruptUnit {
		/// The unit.
		unit:   UnitId,
		/// Decoder error.
		#[source]
		source: postcard::Error,
	},
	/// The host refused the OS disposition of a trapped or ignored signal
	/// ([`Host::set_signal_trap`](crate::bash::Host::set_signal_trap)).
	#[error("could not restore the trap of SIG{sig}")]
	SignalSetup {
		/// The signal.
		sig:    Signal,
		/// The host's error.
		#[source]
		source: std::io::Error,
	},
}

/// Which compatibility check of the frames header failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, strum::Display)]
pub enum Incompatibility {
	/// Not a frames blob (`OBF1` magic missing).
	#[strum(to_string = "bad magic")]
	Magic,
	/// Another IR version.
	#[strum(to_string = "IR version {found}, expected {expected}")]
	IrVersion {
		/// Version in the blob.
		found:    u32,
		/// This engine's version.
		expected: u32,
	},
	/// Another engine build.
	#[strum(to_string = "engine build differs")]
	Build,
}

/// Failure of [`Shell::externalize`](crate::bash::Shell::externalize).
#[derive(Debug, thiserror::Error)]
pub enum ExtError {
	/// The store failed.
	#[error("could not write the snapshot")]
	Store(#[from] StoreError),
	/// Encoding the frames failed.
	#[error("could not encode the frames")]
	Encode(#[source] postcard::Error),
}
