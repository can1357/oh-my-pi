//! `--iconv`: file-name charset conversion between the local charset and the
//! UTF-8 the protocol carries.
//!
//! Spec semantics (upstream setup_iconv): `LOCAL,REMOTE` — the client uses
//! `LOCAL`, a server (including the server half of a local copy) uses
//! `REMOTE`; a single charset is used by whichever side has it; an empty
//! charset or `.` means the locale's charset. Names are converted
//! `local → UTF-8` when they go to the wire ([`Iconv::to_wire_io`]) and
//! `UTF-8 → local` when they come from it ([`Iconv::from_wire`]); invalid or
//! incomplete sequences fail the conversion (no lossy substitution), which
//! callers report per file as `[%s] cannot convert filename: %s (%s)`.
//!
//! Unix uses the C library's `iconv(3)` (libiconv on macOS). Windows has no
//! iconv: the type exists so the engine compiles, but [`Iconv::with_locale`] fails the
//! way a build without ICONV_OPTION does (options already refuse `--iconv`).

use std::io;
use std::sync::Arc;

use crate::rsync::exit::{RERR_UNSUPPORTED, RsyncError};

/// Upstream `UTF8_CHARSET`.
#[cfg(unix)]
const UTF8_CHARSET: &str = "UTF-8";

/// The charset a spec selects for this side (upstream setup_iconv's pick):
/// `""` means "the locale's charset".
pub(crate) fn side_charset(spec: &[u8], am_server: bool) -> &[u8] {
	let part = match spec.iter().position(|&b| b == b',') {
		Some(comma) if am_server => &spec[comma + 1..],
		Some(comma) => &spec[..comma],
		None => spec,
	};
	if part == b"." { b"" } else { part }
}

/// The locale charset, and whether it is libc's answer or a reading of the
/// name that the caller has to report.
pub(crate) struct LocaleCharset {
	/// What `ic_chck` is opened for.
	pub(crate) charset: String,
	/// Which bytes `isprint` accepts after `setlocale(LC_CTYPE, "")`: what a
	/// message is escaped by when there is no `ic_chck` (log.c
	/// `filtered_fwrite`). The C locale's when libc was not asked.
	pub(crate) printable: crate::locale::Printable,
	/// Why [`LocaleCharset::charset`] is read off the locale's name rather
	/// than taken from libc. `None` when libc answered — including when its
	/// answer is the C locale.
	pub(crate) warning: Option<String>,
}

/// The locale charset from the environment (`LC_ALL`, then `LC_CTYPE`, then
/// `LANG`, then libc's own default, [`crate::locale::UNSET_LOCALE`]), the way
/// `nl_langinfo(CODESET)` reports it after `setlocale(LC_CTYPE, "")`: on Unix
/// the codeset of the loaded locale object, so an alias whose name carries no
/// codeset (a generated bare `en_US`, `ISO-8859-1`) reads as the charset it
/// really has, and a name libc cannot load reads as the C locale's ASCII,
/// which is what `setlocale` leaves behind when it fails. `cancel` is the
/// command's cancellation, which a load that never finishes does not delay.
///
/// When libc cannot be asked — the shell's locale search path is not this
/// process's, or another command's load has not finished (see
/// [`crate::locale::loaded_codeset`]) — the charset the name spells out is
/// used and the reason is returned for the caller to print. That reading is
/// right for every name that carries a codeset, because glibc refuses a
/// locale whose data names a different one (`locale/findlocale.c`, the
/// `__gconv_compare_alias` check); for a name without one it is the C
/// locale's ASCII, which is a guess, and the warning says so rather than
/// letting the escaping change without a word.
pub(crate) fn locale_charset(
	env: &dyn Fn(&str) -> Option<String>,
	cancel: &std::sync::atomic::AtomicBool,
) -> LocaleCharset {
	use crate::locale::C_PRINTABLE;
	let known = |charset: String| LocaleCharset { charset, printable: C_PRINTABLE, warning: None };
	let value = ["LC_ALL", "LC_CTYPE", "LANG"]
		.iter()
		.find_map(|key| env(key).filter(|v| !v.is_empty()))
		.unwrap_or_else(|| crate::locale::UNSET_LOCALE.to_owned());
	#[cfg(unix)]
	{
		use crate::locale::Codeset;
		return match crate::locale::loaded_codeset(&value, env, cancel) {
			Codeset::Loaded(charset, printable) => LocaleCharset { charset, printable, warning: None },
			Codeset::Unloadable => known(ascii_codeset().to_owned()),
			Codeset::Unasked(why) => LocaleCharset {
				charset: codeset_named(&value),
				printable: C_PRINTABLE,
				warning: Some(format!(
					"cannot read the locale \"{value}\" the way a command started from this shell would: {why}"
				)),
			},
			Codeset::Cancelled => LocaleCharset { charset: codeset_named(&value), printable: C_PRINTABLE, warning: None },
		};
	}
	#[cfg(not(unix))]
	{
		let _ = cancel;
		if value == "C" || value == "POSIX" {
			return known(ascii_codeset().to_owned());
		}
		known(codeset_of(&value))
	}
}

/// The codeset a locale name stands for when libc could not be asked about
/// it: on musl, which loads any name but C and POSIX with its built-in UTF-8
/// map, UTF-8 (see [`crate::locale::name_reads_as_utf8`]); elsewhere the
/// codeset the name spells ([`codeset_of`]).
#[cfg(unix)]
fn codeset_named(name: &str) -> String {
	if cfg!(target_env = "musl") {
		return match name {
			"C" | "POSIX" => ascii_codeset().to_owned(),
			_ => "UTF-8".to_owned(),
		};
	}
	codeset_of(name)
}

/// The codeset a locale name spells out: what follows the `.` (without an
/// `@modifier`), and `""` — iconv's own "current locale" default — for a name
/// without one. Windows has no locale object to ask, and on Unix this is the
/// fallback for a locale libc could not be asked about.
fn codeset_of(name: &str) -> String {
	let name = name.split('@').next().unwrap_or("");
	match name.split_once('.') {
		Some((_, codeset)) if !codeset.is_empty() => codeset.to_owned(),
		_ if name.eq_ignore_ascii_case("UTF-8") => "UTF-8".to_owned(),
		_ => String::new(),
	}
}

/// What `nl_langinfo(CODESET)` returns for the C locale: glibc's
/// `ANSI_X3.4-1968`, musl's `ASCII` (`src/locale/langinfo.c`), the BSDs'
/// `US-ASCII`.
fn ascii_codeset() -> &'static str {
	if cfg!(target_env = "musl") {
		"ASCII"
	} else if cfg!(target_os = "linux") {
		"ANSI_X3.4-1968"
	} else {
		"US-ASCII"
	}
}

/// How the bytes of a message are checked before they are printed, derived
/// from the locale charset: upstream's `ic_chck`, which setup_iconv opens as
/// `iconv_open(defset, defset)` for a client that escapes, and log.c's
/// `rwrite` runs every message through — each byte the charset cannot
/// represent is printed as `\#ddd`, the rest as it is.
#[derive(Clone, Default)]
pub(crate) enum MsgCharset {
	/// The C/POSIX locale (and any locale libc cannot name a codeset for):
	/// no byte above 0x7F converts, so every one of them is escaped.
	#[default]
	Ascii,
	/// A UTF-8 locale: valid sequences pass, each byte of an invalid one is escaped.
	Utf8,
	/// Any other charset, checked through iconv like upstream.
	Other(Arc<MsgCheck>),
	/// No `ic_chck` (upstream `ic_chck == (iconv_t)-1`: `iconv_open` refused
	/// the charset, or it is not set up yet): each byte the locale's `isprint`
	/// rejects is escaped (log.c `filtered_fwrite`).
	Bytes(Arc<crate::locale::Printable>),
}

impl MsgCharset {
	/// The check a locale charset ([`locale_charset`]) calls for, given which
	/// bytes the locale prints. `Err` says why the charset's conversion could
	/// not be opened at all (see [`crate::locale::libc_locale_load`]); the
	/// caller reports it, unless it is the command's cancellation, and escapes
	/// by printability, as for a charset iconv refuses.
	pub(crate) fn for_locale(
		charset: &str,
		printable: &crate::locale::Printable,
		cancel: &std::sync::atomic::AtomicBool,
	) -> Result<Self, crate::locale::NoAnswer> {
		let is = |name: &str| charset.eq_ignore_ascii_case(name);
		if charset.is_empty() || is(ascii_codeset()) || is("US-ASCII") || is("ASCII") {
			return Ok(Self::Ascii);
		}
		if is("UTF-8") || is("UTF8") {
			return Ok(Self::Utf8);
		}
		Ok(match MsgCheck::open(charset, cancel)? {
			Some(check) => Self::Other(Arc::new(check)),
			None => Self::Bytes(Arc::new(*printable)),
		})
	}
}

/// Upstream's `ic_chck`: a conversion from the locale charset to itself, which
/// converts what the charset accepts and stops at the first byte it does not.
pub(crate) struct MsgCheck {
	#[cfg(unix)]
	conv: sys::Converter,
}

impl MsgCheck {
	/// `Ok(None)` when `iconv_open` refuses the charset (or the platform has
	/// no iconv); `Err` when it could not be asked.
	fn open(
		charset: &str,
		cancel: &std::sync::atomic::AtomicBool,
	) -> Result<Option<Self>, crate::locale::NoAnswer> {
		#[cfg(unix)]
		return Ok(sys::Converter::open(charset, charset, cancel)?.ok().map(|conv| Self { conv }));
		#[cfg(not(unix))]
		{
			let _ = (charset, cancel);
			Ok(None)
		}
	}

	/// The longest prefix of `msg` the charset accepts, converted, and how many
	/// input bytes it came from: a short count means the next byte starts an
	/// invalid or incomplete sequence (upstream rwrite's `iconvbufs` loop).
	pub(crate) fn convert_prefix(&self, msg: &[u8]) -> (Vec<u8>, usize) {
		#[cfg(unix)]
		{
			let (out, used, _) = self.conv.run(msg, false);
			(out, used)
		}
		#[cfg(not(unix))]
		{
			let _ = msg;
			(Vec::new(), 0)
		}
	}
}

/// A pair of open conversions for one side of a transfer.
pub(crate) struct Iconv {
	charset: String,
	#[cfg(unix)]
	send: sys::Converter,
	#[cfg(unix)]
	recv: sys::Converter,
}

impl std::fmt::Debug for Iconv {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Iconv").field("charset", &self.charset).finish()
	}
}

impl Iconv {
	/// Opens the conversions for `spec` (`--iconv` value); `.`/empty select `locale`
	/// (see [`locale_charset`]; None: iconv's own "" default). `cancel` is the
	/// command's cancellation, which conversion data that never arrives does
	/// not delay.
	pub(crate) fn with_locale(
		spec: &[u8],
		am_server: bool,
		locale: Option<&str>,
		cancel: &std::sync::atomic::AtomicBool,
	) -> Result<Self, RsyncError> {
		let chosen = side_charset(spec, am_server);
		let charset = if chosen.is_empty() {
			locale.unwrap_or("").to_owned()
		} else {
			String::from_utf8_lossy(chosen).into_owned()
		};
		Self::open(charset, cancel)
	}

	#[cfg(unix)]
	fn open(charset: String, cancel: &std::sync::atomic::AtomicBool) -> Result<Self, RsyncError> {
		// Upstream's message for a refused charset; one libc could not be
		// asked about also says why. A cancelled open ends as the run does.
		let open = |to: &str, from: &str, line: u32| match sys::Converter::open(to, from, cancel) {
			Ok(Ok(conv)) => Ok(conv),
			Ok(Err(_)) => Err(RsyncError::new(RERR_UNSUPPORTED, format!("iconv_open(\"{to}\", \"{from}\") failed"))
				.at("rsync.c", line)),
			Err(crate::locale::NoAnswer::Cancelled) => Err(RsyncError::cancelled()),
			Err(crate::locale::NoAnswer::Unasked(why)) => Err(RsyncError::new(
				RERR_UNSUPPORTED,
				format!("iconv_open(\"{to}\", \"{from}\") failed: {why}"),
			)
			.at("rsync.c", line)),
		};
		let send = open(UTF8_CHARSET, &charset, 134)?;
		let recv = open(&charset, UTF8_CHARSET, 140)?;
		Ok(Self { charset, send, recv })
	}

	/// No iconv on this platform: upstream's refusal of an option a build lacks.
	#[cfg(not(unix))]
	fn open(charset: String, cancel: &std::sync::atomic::AtomicBool) -> Result<Self, RsyncError> {
		let _ = (charset, cancel);
		Err(RsyncError::new(RERR_UNSUPPORTED, "This rsync does not support --iconv".to_owned()))
	}

	/// The `--debug=ICONV1` line: `[%s] charset: %s` (`[LOCALE]` for iconv's default).
	pub(crate) fn debug_line(&self, who: &str) -> String {
		let shown = if self.charset.is_empty() { "[LOCALE]" } else { self.charset.as_str() };
		format!("[{who}] charset: {shown}\n")
	}

	/// Local charset → UTF-8 (`ic_send`); the error carries the errno (EILSEQ,
	/// EINVAL for a truncated sequence).
	pub(crate) fn to_wire_io(&self, name: &[u8]) -> io::Result<Vec<u8>> {
		#[cfg(unix)]
		return self.send.convert(name);
		#[cfg(not(unix))]
		{
			let _ = name;
			Err(io::ErrorKind::Unsupported.into())
		}
	}

	/// UTF-8 → local charset (`ic_recv`).
	pub(crate) fn from_wire_io(&self, name: &[u8]) -> io::Result<Vec<u8>> {
		#[cfg(unix)]
		return self.recv.convert(name);
		#[cfg(not(unix))]
		{
			let _ = name;
			Err(io::ErrorKind::Unsupported.into())
		}
	}

	/// [`Iconv::from_wire_io`] as an `RsyncError` whose message is
	/// `cannot convert filename: NAME (STRERROR)` (callers add the `[role] ` prefix).
	pub(crate) fn from_wire(&self, name: &[u8]) -> Result<Vec<u8>, RsyncError> {
		self.from_wire_io(name).map_err(|e| convert_error(name, &e))
	}
}

fn convert_error(name: &[u8], err: &io::Error) -> RsyncError {
	RsyncError::new(
		crate::rsync::exit::RERR_PARTIAL,
		format!(
			"cannot convert filename: {} ({})",
			String::from_utf8_lossy(name),
			crate::rsync::log::strerror(err)
		),
	)
}

#[cfg(unix)]
mod sys {
	use std::ffi::{CString, c_char, c_void};
	use std::io;
	use std::sync::{Mutex, PoisonError};
	use std::sync::atomic::AtomicBool;

	use crate::rsync::flists::lock;

	#[allow(non_camel_case_types)]
	type iconv_t = *mut c_void;

	#[cfg_attr(target_vendor = "apple", link(name = "iconv"))]
	unsafe extern "C" {
		fn iconv_open(tocode: *const c_char, fromcode: *const c_char) -> iconv_t;
		fn iconv(
			cd: iconv_t,
			inbuf: *mut *mut c_char,
			inbytesleft: *mut usize,
			outbuf: *mut *mut c_char,
			outbytesleft: *mut usize,
		) -> usize;
		fn iconv_close(cd: iconv_t) -> i32;
	}

	/// One open conversion descriptor. iconv state is per descriptor and not
	/// thread-safe, so every conversion holds the lock.
	pub(super) struct Converter {
		cd: Mutex<Handle>,
	}

	struct Handle(iconv_t);

	// SAFETY: the descriptor is only used while holding the Mutex, so it is never
	// accessed by two threads at once; iconv descriptors are not tied to a thread.
	unsafe impl Send for Handle {}

	/// A descriptor on its way to [`CLOSING`]'s thread. It has no `Drop`, so
	/// handing one over cannot close it again.
	struct Closing(iconv_t);

	// SAFETY: as for `Handle`; only the closing thread touches it, once.
	unsafe impl Send for Closing {}

	/// Descriptors waiting to be closed, and the thread that closes them.
	static CLOSING: Mutex<Option<std::sync::mpsc::Sender<Closing>>> = Mutex::new(None);

	/// Starts [`CLOSING`]'s thread if it is not running.
	///
	/// Called on the locale-load thread before each `iconv_open`, never when
	/// a descriptor is dropped: while glibc `dlopen`s a conversion module it
	/// holds the lock `pthread_create` needs (`_dl_allocate_tls_init`), so no
	/// thread can be started while a module that never arrives is loading.
	/// Under [`crate::locale::libc_locale_load`] no other conversion of ours is
	/// loading at this point, so the start cannot wait on one.
	fn start_closer() {
		let mut closing = CLOSING.lock().unwrap_or_else(PoisonError::into_inner);
		if closing.is_some() {
			return;
		}
		let (send, receive) = std::sync::mpsc::channel::<Closing>();
		let started = std::thread::Builder::new().name("iconv-close".into()).spawn(move || {
			for descriptor in receive {
				// SAFETY: the descriptor came from a successful `iconv_open`,
				// is owned here, and is closed once.
				unsafe { iconv_close(descriptor.0) };
			}
		});
		if started.is_ok() {
			*closing = Some(send);
		}
	}

	impl Drop for Handle {
		fn drop(&mut self) {
			// `iconv_close` waits on the same lock glibc holds while
			// `iconv_open` reads a conversion module
			// (`__gconv_close_transform`), so closing here would block this
			// command — and, through that lock, every other — on
			// configuration that never arrives. One thread does the closing
			// instead ([`start_closer`]): it is the only one that waits, each
			// descriptor is closed once, and a wedged close delays only later
			// closes. No thread is started here.
			let closing = CLOSING.lock().unwrap_or_else(PoisonError::into_inner);
			// No closer (none could be started): close here, as before.
			if !matches!(closing.as_ref().map(|send| send.send(Closing(self.0))), Some(Ok(()))) {
				// SAFETY: as above.
				unsafe { iconv_close(self.0) };
			}
		}
	}

	impl Converter {
		/// Opens a conversion. `iconv_open` reads the conversion configuration
		/// from the search path (`GCONV_PATH`) under a lock libc keeps for the
		/// whole process, so it runs through
		/// [`crate::locale::libc_locale_load`]: configuration that never
		/// arrives holds up neither this command's cancellation nor another
		/// command. The outer `Err` says why libc could not be asked, or that
		/// the command was cancelled first; the inner one is `iconv_open`'s
		/// refusal.
		///
		/// One case is out of reach: glibc `dlopen`s a conversion module while
		/// holding the loader lock `pthread_create` takes
		/// (`_dl_allocate_tls_init`), so a module on omp's own `GCONV_PATH`
		/// that blocks while loading stops every thread start in the process,
		/// and nothing in the builtin can prevent it. It takes whoever starts
		/// omp to configure such a module.
		pub(super) fn open(
			to: &str,
			from: &str,
			cancel: &AtomicBool,
		) -> Result<io::Result<Self>, crate::locale::NoAnswer> {
			let (Ok(to), Ok(from)) = (CString::new(to), CString::new(from)) else {
				return Ok(Err(io::Error::from_raw_os_error(libc::EINVAL)));
			};
			let opened = crate::locale::libc_locale_load(cancel, move || {
				start_closer();
				// SAFETY: both arguments are valid NUL-terminated strings; a
				// descriptor nobody takes is closed by `Handle`'s drop.
				let cd = unsafe { iconv_open(to.as_ptr(), from.as_ptr()) };
				if cd as isize == -1 { Err(io::Error::last_os_error()) } else { Ok(Handle(cd)) }
			})?;
			Ok(opened.map(|handle| Self { cd: Mutex::new(handle) }))
		}

		/// Converts all of `input` (state reset first, like ICB_INIT); an invalid or
		/// truncated sequence fails with its errno.
		pub(super) fn convert(&self, input: &[u8]) -> io::Result<Vec<u8>> {
			let (out, _, err) = self.run(input, true);
			match err {
				Some(err) => Err(err),
				None => Ok(out),
			}
		}

		/// Converts from the start of `input` until it is exhausted or a sequence
		/// the charset refuses is reached: the output, the input bytes consumed,
		/// and the error that stopped it. `flush` ends the conversion by writing
		/// out any shift state.
		pub(super) fn run(&self, input: &[u8], flush: bool) -> (Vec<u8>, usize, Option<io::Error>) {
			let guard = lock(&self.cd);
			let cd = guard.0;
			// SAFETY: null buffers reset the conversion state.
			unsafe {
				iconv(cd, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
			}
			let mut out: Vec<u8> = vec![0; input.len() * 2 + 16];
			let mut in_ptr = input.as_ptr() as *mut c_char;
			let mut in_left = input.len();
			let mut done = 0usize;
			let mut failure = None;
			while in_left > 0 {
				let mut out_ptr = out[done..].as_mut_ptr() as *mut c_char;
				let mut out_left = out.len() - done;
				// SAFETY: in_ptr/in_left describe the unread rest of `input` (iconv only
				// reads through it despite the mut cast); out_ptr/out_left describe the
				// unused tail of `out`, which outlives the call.
				let rc = unsafe { iconv(cd, &mut in_ptr, &mut in_left, &mut out_ptr, &mut out_left) };
				done = out.len() - out_left;
				if rc == usize::MAX {
					let err = io::Error::last_os_error();
					match err.raw_os_error() {
						Some(libc::E2BIG) => {
							let grow = out.len().max(64);
							out.resize(out.len() + grow, 0);
						},
						Some(libc::EINTR) => {},
						_ => {
							failure = Some(err);
							break;
						},
					}
				}
			}
			while flush && failure.is_none() {
				let mut out_ptr = out[done..].as_mut_ptr() as *mut c_char;
				let mut out_left = out.len() - done;
				// SAFETY: a null input flushes; the output range is the unused tail of `out`.
				let rc = unsafe {
					iconv(cd, std::ptr::null_mut(), std::ptr::null_mut(), &mut out_ptr, &mut out_left)
				};
				done = out.len() - out_left;
				if rc == usize::MAX && io::Error::last_os_error().raw_os_error() == Some(libc::E2BIG) {
					let grow = out.len().max(64);
					out.resize(out.len() + grow, 0);
					continue;
				}
				break;
			}
			out.truncate(done);
			(out, input.len() - in_left, failure)
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn side_charset_picks_like_setup_iconv() {
		assert_eq!(side_charset(b"ISO-8859-1,UTF-8", false), b"ISO-8859-1");
		assert_eq!(side_charset(b"ISO-8859-1,UTF-8", true), b"UTF-8");
		assert_eq!(side_charset(b"latin1", true), b"latin1");
		assert_eq!(side_charset(b".", false), b"");
		assert_eq!(side_charset(b"., latin1", false), b"");
		assert_eq!(side_charset(b"", false), b"");
	}

	/// Windows has no locale object, so there the name is all there is; on
	/// Unix this reading is the fallback for a locale libc could not be asked
	/// about.
	#[test]
	fn codeset_of_a_locale_name() {
		assert_eq!(codeset_of("en_US.UTF-8"), "UTF-8");
		assert_eq!(codeset_of("de_DE.ISO8859-1@euro"), "ISO8859-1");
		assert_eq!(codeset_of("UTF-8"), "UTF-8");
		assert_eq!(codeset_of("en_US"), "");
	}

	/// A lookup libc cannot be asked about is reported, not read as the C
	/// locale, and the name's own codeset stands in: silence there would
	/// escape every high-bit byte of a name the reference prints. libc reads
	/// the search path from this process's environment, so the shell's has to
	/// be this process's and absolute; a list variable is read entry by entry
	/// and `LOCALE_ARCHIVE`, one pathname, whole. musl reads none of these
	/// variables, so there is nothing to report there.
	#[cfg(all(unix, not(target_env = "musl")))]
	#[test]
	fn an_unanswerable_lookup_is_reported() {
		let shell = |key: &'static str, value: &'static str| {
			move |k: &str| match k {
				"LC_ALL" => Some("en_US.ISO-8859-1".to_owned()),
				_ if k == key => Some(value.to_owned()),
				_ => inherited(k),
			}
		};
		for (key, value, why) in [
			("LOCPATH", "locales", "LOCPATH names a relative directory"),
			("LOCPATH", "/srv/locales:2026", "LOCPATH names a relative directory"),
			("LOCPATH", "/nonexistent-shell-only", "the shell's LOCPATH is not the one omp was started with"),
			("LOCALE_ARCHIVE", "/srv/locales:2026", "the shell's LOCALE_ARCHIVE is not the one omp"),
			("GCONV_PATH", "/nonexistent-shell-only", "the shell's GCONV_PATH is not the one omp"),
		] {
			let answer = charset_of_env(&shell(key, value));
			assert_eq!(answer.charset, "ISO-8859-1", "{key}={value}: the name's own codeset is the fallback");
			let warning = answer.warning.expect("an unanswerable lookup is reported");
			assert!(warning.contains("en_US.ISO-8859-1") && warning.contains(why), "{key}={value}: {warning}");
		}
		// An answer libc did give carries no warning, whatever it is.
		let c = charset_of_env(&|k: &str| (k == "LC_ALL").then(|| "C".to_owned()).or_else(|| inherited(k)));
		assert_eq!((c.charset.as_str(), c.warning), (ascii_codeset(), None));
	}

	/// The charset is the loaded locale's `nl_langinfo(CODESET)`, not the
	/// codeset its name spells: libc reports `C.utf8` as `UTF-8`, and an alias
	/// carrying no codeset at all (a generated bare `en_US`, measured as
	/// `ISO-8859-1`) would otherwise read as "no charset" and escape bytes the
	/// locale accepts.
	#[cfg(unix)]
	#[test]
	fn charset_comes_from_the_loaded_locale() {
		for name in ["C.utf8", "C.UTF-8", "en_US.utf8"] {
			if crate::locale::locale_loadable(name, libc::LC_CTYPE_MASK) {
				let charset =
					charset_of_env(&|k: &str| (k == "LC_ALL").then(|| name.to_owned()).or_else(|| inherited(k)));
				assert_eq!(charset.charset, "UTF-8", "{name}");
			}
		}
		let c = charset_of_env(&|k: &str| (k == "LC_ALL").then(|| "C".to_owned()).or_else(|| inherited(k)));
		assert_eq!(c.charset, ascii_codeset());
	}

	/// `setlocale` picks `LC_ALL` over `LANG`, and with none of the variables
	/// set selects libc's default: C on glibc, C.UTF-8 on musl (measured on
	/// musl 1.2.5: `CODESET=UTF-8` from an empty environment). What a name the
	/// system has no data for yields is libc's too: glibc's `setlocale` fails
	/// and leaves the C locale, so `LC_ALL=xx_YY.UTF-8` escapes high-bit bytes
	/// like rsync 3.5.1 does; musl makes a UTF-8 locale of any name (measured:
	/// `CODESET=UTF-8`); Windows has no locale object to ask, so the name's own
	/// codeset is all there is.
	#[test]
	fn locale_charset_from_env() {
		let env = |pairs: &'static [(&'static str, &'static str)]| {
			move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned()).or_else(|| inherited(k))
		};
		let unset = charset_of_env(&env(&[])).charset;
		#[cfg(target_env = "musl")]
		assert_eq!(unset, "UTF-8");
		#[cfg(not(target_env = "musl"))]
		assert_eq!(unset, ascii_codeset());
		assert_eq!(charset_of_env(&env(&[("LANG", "C")])).charset, ascii_codeset());
		assert_eq!(charset_of_env(&env(&[("LC_ALL", "C"), ("LANG", "en_US.UTF-8")])).charset, ascii_codeset());
		let unknown = charset_of_env(&env(&[("LC_ALL", "xx_YY.UTF-8")])).charset;
		#[cfg(all(unix, not(target_env = "musl")))]
		assert_eq!(unknown, ascii_codeset());
		#[cfg(any(not(unix), target_env = "musl"))]
		assert_eq!(unknown, "UTF-8");
		if let Some(installed) = utf8_locale_name() {
			let charset =
				charset_of_env(&|k: &str| (k == "LC_CTYPE").then(|| installed.to_owned()).or_else(|| inherited(k)))
					.charset;
			assert!(
				matches!(MsgCharset::for_locale(&charset, &crate::locale::C_PRINTABLE, &never()), Ok(MsgCharset::Utf8)),
				"{charset}"
			);
		}
	}

	/// When libc cannot be asked, a name is read as libc would load it: on
	/// musl every name but C and POSIX is UTF-8 (reading `en_US` as ASCII
	/// there split `é` in two under `fold -w1`), and elsewhere the name has to
	/// spell its codeset.
	#[cfg(unix)]
	#[test]
	fn a_name_libc_could_not_be_asked_about_is_read_as_libc_loads_it() {
		for (name, musl, glibc) in [
			("en_US", "UTF-8", ""),
			("en_US.ISO-8859-1", "UTF-8", "ISO-8859-1"),
			("de_DE.UTF-8@euro", "UTF-8", "UTF-8"),
			("C", ascii_codeset(), ""),
			("POSIX", ascii_codeset(), ""),
		] {
			let expected = if cfg!(target_env = "musl") { musl } else { glibc };
			assert_eq!(codeset_named(name), expected, "{name}");
			let utf8 = expected.eq_ignore_ascii_case("UTF-8");
			assert_eq!(crate::locale::name_reads_as_utf8(name), utf8, "{name}");
		}
	}

	/// The cancellation of a command nothing cancels.
	fn never() -> std::sync::atomic::AtomicBool {
		std::sync::atomic::AtomicBool::new(false)
	}

	/// [`locale_charset`] for a command nothing cancels.
	fn charset_of_env(env: &dyn Fn(&str) -> Option<String>) -> LocaleCharset {
		locale_charset(env, &never())
	}

	/// This process's value of `key` when it is a locale search variable, as a
	/// shell omp started carries it ([`crate::locale::inherited_search_path`]).
	fn inherited(key: &str) -> Option<String> {
		crate::locale::inherited_search_path().into_iter().find(|(name, _)| *name == key).map(|(_, value)| value)
	}

	/// A UTF-8 locale this host can load, if it has one (glibc and musl spell
	/// the portable one `C.UTF-8`, Darwin `UTF-8`).
	fn utf8_locale_name() -> Option<&'static str> {
		#[cfg(unix)]
		return ["C.UTF-8", "C.utf8", "en_US.UTF-8", "UTF-8"]
			.into_iter()
			.find(|name| crate::locale::locale_loadable(name, libc::LC_CTYPE_MASK));
		#[cfg(not(unix))]
		return Some("C.UTF-8");
	}

	#[cfg(unix)]
	#[test]
	fn utf8_latin1_round_trip() {
		let ic = Iconv::with_locale(b"ISO-8859-1", false, None, &never()).unwrap();
		let local = b"caf\xe9-\xfc.txt";
		let wire = ic.to_wire_io(local).unwrap();
		assert_eq!(wire, "café-ü.txt".as_bytes());
		assert_eq!(ic.from_wire(&wire).unwrap(), local);
		assert_eq!(ic.debug_line("sender"), "[sender] charset: ISO-8859-1\n");
	}

	#[cfg(unix)]
	#[test]
	fn server_uses_remote_half_of_spec() {
		let ic = Iconv::with_locale(b"UTF-8,ISO-8859-1", true, None, &never()).unwrap();
		assert_eq!(ic.debug_line("receiver"), "[receiver] charset: ISO-8859-1\n");
		assert_eq!(ic.from_wire("é".as_bytes()).unwrap(), b"\xe9");
	}

	/// A character the target charset cannot represent is an error with
	/// glibc's iconv, as with rsync built against it; musl's iconv writes
	/// `*` for it instead and reports no error (musl `src/locale/iconv.c`), as
	/// it does for rsync built against musl. Truncated input is an error with
	/// both.
	#[cfg(unix)]
	#[test]
	fn invalid_sequence_is_reported() {
		let ic = Iconv::with_locale(b"ISO-8859-1", false, None, &never()).unwrap();
		// Not representable in Latin-1.
		let converted = ic.from_wire("snow\u{2603}".as_bytes());
		#[cfg(not(target_env = "musl"))]
		{
			let msg = converted.unwrap_err().message.unwrap();
			assert!(msg.starts_with("cannot convert filename: snow"), "{msg}");
		}
		#[cfg(target_env = "musl")]
		assert_eq!(converted.unwrap(), b"snow*");
		// Truncated UTF-8 input.
		assert!(ic.from_wire(b"ab\xc3").is_err());
	}

	#[cfg(unix)]
	#[test]
	fn unknown_charset_fails_like_upstream() {
		let err = Iconv::with_locale(b"NO-SUCH-CHARSET-XYZ", false, Some("UTF-8"), &never()).unwrap_err();
		assert_eq!(err.code, RERR_UNSUPPORTED);
		assert_eq!(
			err.message.as_deref(),
			Some("iconv_open(\"UTF-8\", \"NO-SUCH-CHARSET-XYZ\") failed")
		);
	}
}
