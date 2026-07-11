//! Facilities for configuring trap handlers.

use std::{collections::HashMap, fmt::Display, str::FromStr};

use itertools::Itertools as _;

use crate::{error, sys};

/// Type of signal that can be trapped in the shell.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TrapSignal {
	/// A system signal.
	Signal(sys::signal::Signal),
	/// The `DEBUG` trap.
	Debug,
	/// The `ERR` trap.
	Err,
	/// The `EXIT` trap.
	Exit,
	/// The `RETURN` trp.
	Return,
}

#[cfg(feature = "serde")]
impl serde::Serialize for TrapSignal {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: serde::Serializer,
	{
		serializer.serialize_str(self.as_str())
	}
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for TrapSignal {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		let s = String::deserialize(deserializer)?;
		Self::try_from(s.as_str()).map_err(serde::de::Error::custom)
	}
}

impl Display for TrapSignal {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(self.as_str())
	}
}

impl TrapSignal {
	/// Returns all possible values of [`TrapSignal`].
	pub fn iterator() -> impl Iterator<Item = Self> {
		const SIGNALS: &[TrapSignal] = &[TrapSignal::Debug, TrapSignal::Err, TrapSignal::Exit];

		let iter = itertools::chain!(
			SIGNALS.iter().copied(),
			sys::signal::Signal::iterator().map(TrapSignal::Signal)
		);

		iter
	}

	/// Converts [`TrapSignal`] into its corresponding signal name as a
	/// [`&'static str`](str)
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Signal(s) => s.as_str(),
			Self::Debug => "DEBUG",
			Self::Err => "ERR",
			Self::Exit => "EXIT",
			Self::Return => "RETURN",
		}
	}
}

/// Formats [`Iterator<Item = TrapSignal>`](TrapSignal)  to the provided writer.
///
/// # Arguments
///
/// * `f` - Any type that implements [`std::io::Write`].
/// * `it` - An iterator over the signals that will be formatted into the `f`.
pub fn format_signals(
	mut f: impl std::io::Write,
	it: impl Iterator<Item = TrapSignal>,
) -> Result<(), error::Error> {
	let it = it
		.filter_map(|s| i32::try_from(s).ok().map(|n| (s, n)))
		.sorted_by(|a, b| Ord::cmp(&a.1, &b.1))
		.format_with("\n", |s, f| f(&format_args!("{}) {}", s.1, s.0)));
	write!(f, "{it}")?;
	Ok(())
}

// implement s.parse::<TrapSignal>()
impl FromStr for TrapSignal {
	type Err = error::Error;

	fn from_str(s: &str) -> Result<Self, <Self as FromStr>::Err> {
		if let Ok(n) = s.parse::<i32>() {
			Self::try_from(n)
		} else {
			Self::try_from(s)
		}
	}
}

// from a signal number
impl TryFrom<i32> for TrapSignal {
	type Error = error::Error;

	fn try_from(value: i32) -> Result<Self, Self::Error> {
		// NOTE: DEBUG and ERR are real-time signals, defined based on NSIG or SIGRTMAX
		// (is not available on bsd-like systems),
		// and don't have persistent numbers across platforms, so we skip them here.
		Ok(match value {
			0 => Self::Exit,
			value => Self::Signal(
				sys::signal::Signal::try_from(value)
					.map_err(|_| error::ErrorKind::InvalidSignal(value.to_string()))?,
			),
		})
	}
}

// from a signal name
impl TryFrom<&str> for TrapSignal {
	type Error = error::Error;

	fn try_from(value: &str) -> Result<Self, Self::Error> {
		#[allow(unused_mut, reason = "only mutated on some platforms")]
		let mut s = value.to_ascii_uppercase();

		Ok(match s.as_str() {
			"DEBUG" => Self::Debug,
			"ERR" => Self::Err,
			"EXIT" => Self::Exit,
			"RETURN" => Self::Return,
			_ => {
				// Bash compatibility:
				// support for signal names without the `SIG` prefix, for example `HUP` ->
				// `SIGHUP`
				if !s.starts_with("SIG") {
					s.insert_str(0, "SIG");
				}
				sys::signal::Signal::from_str(s.as_str())
					.map(TrapSignal::Signal)
					.map_err(|_| error::ErrorKind::InvalidSignal(value.into()))?
			},
		})
	}
}

/// Error type used when failing to convert a `TrapSignal` to a number.
#[derive(Debug, Clone, Copy)]
pub struct TrapSignalNumberError;

impl TryFrom<TrapSignal> for i32 {
	type Error = TrapSignalNumberError;

	fn try_from(value: TrapSignal) -> Result<Self, Self::Error> {
		Ok(match value {
			TrapSignal::Signal(s) => s as Self,
			TrapSignal::Exit => 0,
			_ => return Err(TrapSignalNumberError),
		})
	}
}

/// A handler for a trap signal.
#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct TrapHandler {
	/// The source text of the command to invoke.
	pub command:     String,
	/// Source information for where the trap handler was defined.
	pub source_info: crate::SourceInfo,
}

/// Configuration for trap handlers in the shell.
#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct TrapHandlerConfig {
	/// Registered handlers for traps; maps signal type to command.
	handlers: HashMap<TrapSignal, TrapHandler>,
}

impl TrapHandlerConfig {
	/// Iterates over the registered handlers for trap signals.
	pub fn iter_handlers(&self) -> impl Iterator<Item = (TrapSignal, &TrapHandler)> {
		self
			.handlers
			.iter()
			.map(|(signal, handler)| (*signal, handler))
	}

	/// Tries to find the handler associated with the given signal.
	///
	/// # Arguments
	///
	/// * `signal_type` - The type of signal to get the handler for.
	pub fn get_handler(&self, signal_type: TrapSignal) -> Option<&TrapHandler> {
		self.handlers.get(&signal_type)
	}

	/// Returns whether a handler is registered for the given signal.
	pub fn handles(&self, signal_type: TrapSignal) -> bool {
		self.handlers.contains_key(&signal_type)
	}

	/// Registers a handler for a trap signal.
	///
	/// # Arguments
	///
	/// * `signal_type` - The type of signal to register a handler for.
	/// * `command` - The command to execute when the signal is trapped.
	/// * `source_info` - The source info for where the trap handler was defined.
	pub fn register_handler(
		&mut self,
		signal_type: TrapSignal,
		command: String,
		source_info: crate::SourceInfo,
	) {
		let _ = self
			.handlers
			.insert(signal_type, TrapHandler { command, source_info });
	}

	/// Removes handlers for a trap signal.
	///
	/// # Arguments
	///
	/// * `signal_type` - The type of signal to remove handlers for.
	pub fn remove_handlers(&mut self, signal_type: TrapSignal) {
		self.handlers.remove(&signal_type);
	}
}
