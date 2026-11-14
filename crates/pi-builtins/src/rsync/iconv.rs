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

/// The locale charset from the environment (`LC_ALL`, then `LC_CTYPE`, then
/// `LANG`), the way `nl_langinfo(CODESET)` reports it after
/// `setlocale(LC_CTYPE, "")`: the codeset after `.` (without an `@modifier`),
/// ASCII for the C/POSIX locale, and `""` (iconv's own default) otherwise.
pub(crate) fn locale_charset(env: &dyn Fn(&str) -> Option<String>) -> String {
	let value = ["LC_ALL", "LC_CTYPE", "LANG"]
		.iter()
		.find_map(|key| env(key).filter(|v| !v.is_empty()));
	let Some(value) = value else {
		return ascii_codeset().to_owned();
	};
	if value == "C" || value == "POSIX" {
		return ascii_codeset().to_owned();
	}
	let value = value.split('@').next().unwrap_or("");
	match value.split_once('.') {
		Some((_, codeset)) if !codeset.is_empty() => codeset.to_owned(),
		_ if value.eq_ignore_ascii_case("UTF-8") => "UTF-8".to_owned(),
		_ => String::new(),
	}
}

/// What `nl_langinfo(CODESET)` returns for the C locale.
fn ascii_codeset() -> &'static str {
	if cfg!(target_os = "linux") { "ANSI_X3.4-1968" } else { "US-ASCII" }
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
	/// (see [`locale_charset`]; None: iconv's own "" default).
	pub(crate) fn with_locale(
		spec: &[u8],
		am_server: bool,
		locale: Option<&str>,
	) -> Result<Self, RsyncError> {
		let chosen = side_charset(spec, am_server);
		let charset = if chosen.is_empty() {
			locale.unwrap_or("").to_owned()
		} else {
			String::from_utf8_lossy(chosen).into_owned()
		};
		Self::open(charset)
	}

	#[cfg(unix)]
	fn open(charset: String) -> Result<Self, RsyncError> {
		let send = sys::Converter::open(UTF8_CHARSET, &charset).map_err(|_| {
			RsyncError::new(
				RERR_UNSUPPORTED,
				format!("iconv_open(\"{UTF8_CHARSET}\", \"{charset}\") failed"),
			)
			.at("rsync.c", 134)
		})?;
		let recv = sys::Converter::open(&charset, UTF8_CHARSET).map_err(|_| {
			RsyncError::new(
				RERR_UNSUPPORTED,
				format!("iconv_open(\"{charset}\", \"{UTF8_CHARSET}\") failed"),
			)
			.at("rsync.c", 140)
		})?;
		Ok(Self { charset, send, recv })
	}

	/// No iconv on this platform: upstream's refusal of an option a build lacks.
	#[cfg(not(unix))]
	fn open(charset: String) -> Result<Self, RsyncError> {
		let _ = charset;
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
	use std::sync::Mutex;

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

	impl Drop for Handle {
		fn drop(&mut self) {
			// SAFETY: the descriptor came from a successful iconv_open and is closed once.
			unsafe {
				iconv_close(self.0);
			}
		}
	}

	impl Converter {
		pub(super) fn open(to: &str, from: &str) -> io::Result<Self> {
			let to = CString::new(to).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
			let from = CString::new(from).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
			// SAFETY: both arguments are valid NUL-terminated strings.
			let cd = unsafe { iconv_open(to.as_ptr(), from.as_ptr()) };
			if cd as isize == -1 {
				return Err(io::Error::last_os_error());
			}
			Ok(Self { cd: Mutex::new(Handle(cd)) })
		}

		/// Converts all of `input` (state reset first, like ICB_INIT); an invalid or
		/// truncated sequence fails with its errno.
		pub(super) fn convert(&self, input: &[u8]) -> io::Result<Vec<u8>> {
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
						_ => return Err(err),
					}
				}
			}
			// Flush any shift state.
			loop {
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
			Ok(out)
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

	#[test]
	fn locale_charset_from_env() {
		let env = |pairs: &'static [(&'static str, &'static str)]| {
			move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
		};
		assert_eq!(locale_charset(&env(&[("LANG", "en_US.UTF-8")])), "UTF-8");
		assert_eq!(locale_charset(&env(&[("LC_ALL", "de_DE.ISO8859-1@euro"), ("LANG", "x.UTF-8")])), "ISO8859-1");
		assert_eq!(locale_charset(&env(&[("LC_CTYPE", "UTF-8")])), "UTF-8");
		assert_eq!(locale_charset(&env(&[("LANG", "C")])), ascii_codeset());
		assert_eq!(locale_charset(&env(&[])), ascii_codeset());
	}

	#[cfg(unix)]
	#[test]
	fn utf8_latin1_round_trip() {
		let ic = Iconv::with_locale(b"ISO-8859-1", false, None).unwrap();
		let local = b"caf\xe9-\xfc.txt";
		let wire = ic.to_wire_io(local).unwrap();
		assert_eq!(wire, "café-ü.txt".as_bytes());
		assert_eq!(ic.from_wire(&wire).unwrap(), local);
		assert_eq!(ic.debug_line("sender"), "[sender] charset: ISO-8859-1\n");
	}

	#[cfg(unix)]
	#[test]
	fn server_uses_remote_half_of_spec() {
		let ic = Iconv::with_locale(b"UTF-8,ISO-8859-1", true, None).unwrap();
		assert_eq!(ic.debug_line("receiver"), "[receiver] charset: ISO-8859-1\n");
		assert_eq!(ic.from_wire("é".as_bytes()).unwrap(), b"\xe9");
	}

	#[cfg(unix)]
	#[test]
	fn invalid_sequence_is_reported() {
		let ic = Iconv::with_locale(b"ISO-8859-1", false, None).unwrap();
		// Not representable in Latin-1.
		let err = ic.from_wire("snow\u{2603}".as_bytes()).unwrap_err();
		let msg = err.message.unwrap();
		assert!(msg.starts_with("cannot convert filename: snow"), "{msg}");
		// Truncated UTF-8 input.
		assert!(ic.from_wire(b"ab\xc3").is_err());
	}

	#[cfg(unix)]
	#[test]
	fn unknown_charset_fails_like_upstream() {
		let err = Iconv::with_locale(b"NO-SUCH-CHARSET-XYZ", false, Some("UTF-8")).unwrap_err();
		assert_eq!(err.code, RERR_UNSUPPORTED);
		assert_eq!(
			err.message.as_deref(),
			Some("iconv_open(\"UTF-8\", \"NO-SUCH-CHARSET-XYZ\") failed")
		);
	}
}
