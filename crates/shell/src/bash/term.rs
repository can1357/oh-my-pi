//! The terminal seam: what a shell asks of the terminals its host has.
//!
//! [`Host::terminal`](crate::bash::Host::terminal) returns a [`Terminal`]
//! when the host runs on real terminals (the process shell, `omp zsh`);
//! hosts without terminals (agent shells, the testkit) return `None`, and
//! everything that needs one (ZLE, job control's terminal handoff, `zpty`)
//! then reports that no terminal is available.
//!
//! Terminals are addressed by the [`OsHandle`] of an open [`File`]
//! ([`File::os_handle`]): the shell's own tty (zsh's `SHTTY`, from
//! [`Terminal::open_controlling`]), any fd of the shell that is a terminal,
//! or either side of a pty from [`Terminal::open_pty`].
//!
//! [`Termios`] is a portable copy of a terminal's modes: named flags,
//! control characters, `VMIN`/`VTIME` and speeds, plus the host's own
//! encoding as read, so the bits it does not name survive a get/set round
//! trip. It serializes, so a job's saved modes can live in the store.

use std::io;

use bstr::BString;
use serde::{Deserialize, Serialize};

use crate::bash::{
	fs::File,
	host::{OsHandle, TtyInfo},
};

/// A terminal mode flag (`termios` `c_iflag`, `c_oflag`, `c_cflag` and
/// `c_lflag` bits). A host ignores flags its platform lacks (they read as
/// clear).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum TermFlag {
	// Input modes.
	/// `IGNBRK`: ignore a break condition.
	Ignbrk,
	/// `BRKINT`: a break flushes the queues and sends `SIGINT`.
	Brkint,
	/// `IGNPAR`: ignore bytes with parity errors.
	Ignpar,
	/// `PARMRK`: mark parity errors.
	Parmrk,
	/// `INPCK`: enable input parity checking.
	Inpck,
	/// `ISTRIP`: strip the eighth bit.
	Istrip,
	/// `INLCR`: translate NL to CR on input.
	Inlcr,
	/// `IGNCR`: ignore CR on input.
	Igncr,
	/// `ICRNL`: translate CR to NL on input.
	Icrnl,
	/// `IUCLC`: map upper case to lower case on input (Linux).
	Iuclc,
	/// `IXON`: XON/XOFF flow control on output.
	Ixon,
	/// `IXANY`: any character restarts stopped output.
	Ixany,
	/// `IXOFF`: XON/XOFF flow control on input.
	Ixoff,
	/// `IMAXBEL`: ring the bell when the input queue is full.
	Imaxbel,
	/// `IUTF8`: the input is UTF-8 (erase deletes whole characters).
	Iutf8,
	// Output modes.
	/// `OPOST`: post-process output.
	Opost,
	/// `OLCUC`: map lower case to upper case on output (Linux).
	Olcuc,
	/// `ONLCR`: translate NL to CR-NL on output.
	Onlcr,
	/// `OCRNL`: translate CR to NL on output.
	Ocrnl,
	/// `ONOCR`: no CR output at column 0.
	Onocr,
	/// `ONLRET`: NL performs the CR function.
	Onlret,
	// Control modes.
	/// `CSTOPB`: two stop bits.
	Cstopb,
	/// `CREAD`: enable the receiver.
	Cread,
	/// `PARENB`: parity generation and detection.
	Parenb,
	/// `PARODD`: odd parity.
	Parodd,
	/// `HUPCL`: hang up on last close.
	Hupcl,
	/// `CLOCAL`: ignore modem status lines.
	Clocal,
	/// `CRTSCTS`: RTS/CTS flow control.
	Crtscts,
	// Local modes.
	/// `ISIG`: INTR, QUIT and SUSP generate signals.
	Isig,
	/// `ICANON`: canonical (line) input.
	Icanon,
	/// `XCASE`: canonical upper/lower presentation (Linux).
	Xcase,
	/// `ECHO`: echo input.
	Echo,
	/// `ECHOE`: ERASE erases the previous character.
	Echoe,
	/// `ECHOK`: KILL erases the line.
	Echok,
	/// `ECHONL`: echo NL even without `ECHO`.
	Echonl,
	/// `NOFLSH`: no flush after a signal character.
	Noflsh,
	/// `TOSTOP`: background writes send `SIGTTOU`.
	Tostop,
	/// `ECHOCTL`: echo control characters as `^X`.
	Echoctl,
	/// `ECHOPRT`: hardcopy erase echo.
	Echoprt,
	/// `ECHOKE`: KILL erases each character of the line.
	Echoke,
	/// `FLUSHO`: output is being flushed.
	Flusho,
	/// `PENDIN`: retype pending input at the next read.
	Pendin,
	/// `IEXTEN`: implementation-defined input processing (LNEXT, WERASE, …).
	Iexten,
	/// `EXTPROC`: external processing.
	Extproc,
}

impl TermFlag {
	/// Every flag, in declaration order.
	pub const ALL: [Self; 44] = [
		Self::Ignbrk,
		Self::Brkint,
		Self::Ignpar,
		Self::Parmrk,
		Self::Inpck,
		Self::Istrip,
		Self::Inlcr,
		Self::Igncr,
		Self::Icrnl,
		Self::Iuclc,
		Self::Ixon,
		Self::Ixany,
		Self::Ixoff,
		Self::Imaxbel,
		Self::Iutf8,
		Self::Opost,
		Self::Olcuc,
		Self::Onlcr,
		Self::Ocrnl,
		Self::Onocr,
		Self::Onlret,
		Self::Cstopb,
		Self::Cread,
		Self::Parenb,
		Self::Parodd,
		Self::Hupcl,
		Self::Clocal,
		Self::Crtscts,
		Self::Isig,
		Self::Icanon,
		Self::Xcase,
		Self::Echo,
		Self::Echoe,
		Self::Echok,
		Self::Echonl,
		Self::Noflsh,
		Self::Tostop,
		Self::Echoctl,
		Self::Echoprt,
		Self::Echoke,
		Self::Flusho,
		Self::Pendin,
		Self::Iexten,
		Self::Extproc,
	];

	const fn bit(self) -> u64 {
		1 << self as u8
	}
}

/// A special control character (`c_cc`). A host ignores characters its
/// platform lacks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum CtlChar {
	/// `VINTR` (`^C`).
	Intr,
	/// `VQUIT` (`^\`).
	Quit,
	/// `VERASE` (`^?`).
	Erase,
	/// `VKILL` (`^U`).
	Kill,
	/// `VEOF` (`^D`).
	Eof,
	/// `VEOL`.
	Eol,
	/// `VEOL2`.
	Eol2,
	/// `VSTART` (`^Q`).
	Start,
	/// `VSTOP` (`^S`).
	Stop,
	/// `VSUSP` (`^Z`).
	Susp,
	/// `VDSUSP` (`^Y`, BSD).
	Dsusp,
	/// `VLNEXT` (`^V`).
	Lnext,
	/// `VWERASE` (`^W`).
	Werase,
	/// `VREPRINT` (`^R`).
	Reprint,
	/// `VDISCARD` (`^O`).
	Discard,
	/// `VSTATUS` (`^T`, BSD).
	Status,
	/// `VSWTC` (Linux).
	Swtc,
}

impl CtlChar {
	/// Every control character, in declaration order.
	pub const ALL: [Self; Self::COUNT] = [
		Self::Intr,
		Self::Quit,
		Self::Erase,
		Self::Kill,
		Self::Eof,
		Self::Eol,
		Self::Eol2,
		Self::Start,
		Self::Stop,
		Self::Susp,
		Self::Dsusp,
		Self::Lnext,
		Self::Werase,
		Self::Reprint,
		Self::Discard,
		Self::Status,
		Self::Swtc,
	];
	/// How many there are.
	pub const COUNT: usize = 17;
}

/// A terminal's modes ([`Terminal::attrs`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Termios {
	/// Set [`TermFlag`]s, one bit each.
	flags:         u64,
	/// Bits per character (`CSIZE`: 5 to 8).
	pub char_size: u8,
	/// Control characters by [`CtlChar`]; `None` is disabled
	/// (`_POSIX_VDISABLE`).
	pub chars:     [Option<u8>; CtlChar::COUNT],
	/// `VMIN`: bytes a non-canonical read waits for.
	pub min:       u8,
	/// `VTIME`: a non-canonical read's timeout, in tenths of a second.
	pub time:      u8,
	/// Input speed in baud (0: hang up / unknown).
	pub ispeed:    u32,
	/// Output speed in baud.
	pub ospeed:    u32,
	/// The host's own encoding as read: setting starts from it, so bits
	/// the fields above do not name survive. Empty for modes built from
	/// scratch; a host ignores an encoding that is not its own.
	pub os:        Vec<u8>,
}

impl Default for Termios {
	fn default() -> Self {
		Self {
			flags:     0,
			char_size: 8,
			chars:     [None; CtlChar::COUNT],
			min:       1,
			time:      0,
			ispeed:    0,
			ospeed:    0,
			os:        Vec::new(),
		}
	}
}

impl Termios {
	/// Whether `flag` is set.
	#[must_use]
	pub const fn get(&self, flag: TermFlag) -> bool {
		self.flags & flag.bit() != 0
	}

	/// Set or clear `flag`.
	pub const fn set(&mut self, flag: TermFlag, on: bool) {
		if on {
			self.flags |= flag.bit();
		} else {
			self.flags &= !flag.bit();
		}
	}

	/// The control character `c` (`None`: disabled).
	#[must_use]
	pub const fn char(&self, c: CtlChar) -> Option<u8> {
		self.chars[c as usize]
	}

	/// Set (or disable, `None`) the control character `c`.
	pub const fn set_char(&mut self, c: CtlChar, value: Option<u8>) {
		self.chars[c as usize] = value;
	}

	/// `cfmakeraw`: no input or output processing, no echo, no signals, no
	/// line editing, 8-bit characters; reads return after one byte.
	pub const fn make_raw(&mut self) {
		use TermFlag as F;
		let clear = [
			F::Ignbrk,
			F::Brkint,
			F::Parmrk,
			F::Istrip,
			F::Inlcr,
			F::Igncr,
			F::Icrnl,
			F::Ixon,
			F::Opost,
			F::Echo,
			F::Echonl,
			F::Icanon,
			F::Isig,
			F::Iexten,
			F::Parenb,
		];
		let mut i = 0;
		while i < clear.len() {
			self.set(clear[i], false);
			i += 1;
		}
		self.char_size = 8;
		self.min = 1;
		self.time = 0;
	}
}

/// When [`Terminal::set_attrs`] takes effect (`tcsetattr`'s
/// `optional_actions`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum SetWhen {
	/// `TCSANOW`: at once.
	Now,
	/// `TCSADRAIN`: after pending output is written (zsh's choice).
	#[default]
	Drain,
	/// `TCSAFLUSH`: after pending output is written; pending input is
	/// discarded.
	Flush,
}

/// The shell's own terminal (zsh's `SHTTY`), from
/// [`Terminal::open_controlling`].
pub struct Shtty {
	/// The terminal, open for reading and writing on a host descriptor the
	/// shell's commands never see (zsh: an fd of 10 or above, close-on-exec).
	pub file: Box<dyn File>,
	/// Its device name (zsh's `$TTY`; `/dev/tty` when the name is unknown).
	pub name: BString,
}

/// A new pseudo-terminal pair ([`Terminal::open_pty`]).
pub struct Pty {
	/// The controlling side (what a terminal emulator reads and writes).
	pub master: Box<dyn File>,
	/// The terminal side a program runs on.
	pub slave:  Box<dyn File>,
	/// The terminal side's device name.
	pub name:   BString,
}

/// Terminal control of a host whose shells run on real terminals.
///
/// Every operation on a handle fails with `ENOTTY` when it is not a
/// terminal, as the system calls do.
pub trait Terminal {
	/// Whether `h` is a terminal (`isatty`).
	fn is_terminal(&self, h: OsHandle) -> bool;
	/// The modes of terminal `h` (`tcgetattr`).
	fn attrs(&self, h: OsHandle) -> io::Result<Termios>;
	/// Change the modes of terminal `h` (`tcsetattr`). A host that restores
	/// terminals when its shell ends records the modes it first found.
	fn set_attrs(&mut self, h: OsHandle, attrs: &Termios, when: SetWhen) -> io::Result<()>;
	/// The window size of terminal `h` (`TIOCGWINSZ`).
	fn size(&self, h: OsHandle) -> io::Result<TtyInfo>;
	/// Set the window size of terminal `h` (`TIOCSWINSZ`; the kernel sends
	/// `SIGWINCH` to its foreground process group).
	fn set_size(&mut self, h: OsHandle, size: TtyInfo) -> io::Result<()>;
	/// The foreground process group of terminal `h` (`tcgetpgrp`).
	fn foreground(&self, h: OsHandle) -> io::Result<i32>;
	/// Make `pgid` the foreground process group of terminal `h`
	/// (`tcsetpgrp`, with `SIGTTOU` blocked so a shell in a background
	/// group can take the terminal back).
	fn set_foreground(&mut self, h: OsHandle, pgid: i32) -> io::Result<()>;
	/// The session leader of terminal `h` (`tcgetsid`).
	fn session(&self, h: OsHandle) -> io::Result<i32>;
	/// The device name of terminal `h` (`ttyname`).
	fn name(&self, h: OsHandle) -> io::Result<BString>;
	/// The process group of the shell's process (`getpgrp`).
	fn process_group(&self) -> i32;
	/// Put process `pid` (0: the shell's own) into process group `pgid`
	/// (0: `pid`'s own number) (`setpgid`).
	fn set_process_group(&mut self, pid: i32, pgid: i32) -> io::Result<()>;
	/// Open the shell's terminal as zsh's `init_io` does: the tty on fd 0
	/// (reopened read-write by name, else fd 0 itself when it is open
	/// read-write), else fd 1's, else `/dev/tty`; moved to a descriptor of
	/// 10 or above, close-on-exec. `None` when there is none.
	fn open_controlling(&mut self) -> io::Result<Option<Shtty>>;
	/// Open a new pseudo-terminal pair, with window size `size` if given
	/// (`openpty`). Both sides are close-on-exec host descriptors.
	fn open_pty(&mut self, size: Option<TtyInfo>) -> io::Result<Pty>;
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn flags_and_chars_round_trip() {
		let mut t = Termios::default();
		for f in TermFlag::ALL {
			assert!(!t.get(f));
			t.set(f, true);
			assert!(t.get(f));
		}
		t.set(TermFlag::Echo, false);
		assert!(!t.get(TermFlag::Echo));
		assert!(t.get(TermFlag::Icanon));
		t.set_char(CtlChar::Intr, Some(3));
		assert_eq!(t.char(CtlChar::Intr), Some(3));
		assert_eq!(t.char(CtlChar::Susp), None);
	}

	#[test]
	fn make_raw_clears_line_discipline() {
		let mut t = Termios::default();
		for f in [TermFlag::Icanon, TermFlag::Echo, TermFlag::Isig, TermFlag::Icrnl, TermFlag::Opost]
		{
			t.set(f, true);
		}
		t.set(TermFlag::Hupcl, true);
		t.min = 0;
		t.time = 5;
		t.make_raw();
		assert!(!t.get(TermFlag::Icanon) && !t.get(TermFlag::Echo) && !t.get(TermFlag::Isig));
		assert!(!t.get(TermFlag::Icrnl) && !t.get(TermFlag::Opost));
		assert!(t.get(TermFlag::Hupcl));
		assert_eq!((t.min, t.time, t.char_size), (1, 0, 8));
	}
}
