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
	/// Why [`LocaleCharset::charset`] is read off the locale's name rather
	/// than taken from libc. `None` when libc answered — including when its
	/// answer is the C locale.
	pub(crate) warning: Option<String>,
}

/// The locale charset from the environment (`LC_ALL`, then `LC_CTYPE`, then
/// `LANG`), the way `nl_langinfo(CODESET)` reports it after
/// `setlocale(LC_CTYPE, "")`: on Unix the codeset of the loaded locale
/// object, so an alias whose name carries no codeset (a generated bare
/// `en_US`, `ISO-8859-1`) reads as the charset it really has, and a name libc
/// cannot load reads as the C locale's ASCII, which is what `setlocale`
/// leaves behind when it fails. `child` carries the shell's working
/// directory, which a relative locale search path resolves against (see
/// [`crate::locale::loaded_codeset`]).
///
/// When libc cannot be asked at all, the charset the name spells out is used
/// and the reason is returned for the caller to print. That reading is right
/// for every name that carries a codeset, because glibc refuses a locale
/// whose data names a different one (`locale/findlocale.c`, the
/// `__gconv_compare_alias` check); for a name without one it is the C
/// locale's ASCII, which is a guess, and the warning says so rather than
/// letting the escaping change without a word.
pub(crate) fn locale_charset(
	env: &dyn Fn(&str) -> Option<String>,
	child: Option<&crate::host::ChildEnv>,
) -> LocaleCharset {
	let known = |charset: String| LocaleCharset { charset, warning: None };
	let value = ["LC_ALL", "LC_CTYPE", "LANG"]
		.iter()
		.find_map(|key| env(key).filter(|v| !v.is_empty()));
	let Some(value) = value else {
		return known(ascii_codeset().to_owned());
	};
	#[cfg(unix)]
	{
		use crate::locale::Codeset;
		return match crate::locale::loaded_codeset(&value, env, child) {
			Codeset::Loaded(codeset) => known(codeset),
			Codeset::Unloadable => known(ascii_codeset().to_owned()),
			Codeset::Unasked(why) => LocaleCharset {
				charset: codeset_of(&value),
				warning: Some(format!(
					"cannot read the locale \"{value}\" the way a command started from this shell would: {why}"
				)),
			},
		};
	}
	#[cfg(not(unix))]
	{
		let _ = child;
		if value == "C" || value == "POSIX" {
			return known(ascii_codeset().to_owned());
		}
		known(codeset_of(&value))
	}
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

/// What `nl_langinfo(CODESET)` returns for the C locale.
fn ascii_codeset() -> &'static str {
	if cfg!(target_os = "linux") { "ANSI_X3.4-1968" } else { "US-ASCII" }
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
	/// `iconv_open` refused the charset (upstream `ic_chck == (iconv_t)-1`):
	/// the caller falls back to escaping by printability.
	Bytes,
}

impl MsgCharset {
	/// The check a locale charset ([`locale_charset`]) calls for.
	pub(crate) fn for_locale(charset: &str) -> Self {
		let is = |name: &str| charset.eq_ignore_ascii_case(name);
		if charset.is_empty() || is(ascii_codeset()) || is("US-ASCII") || is("ASCII") {
			return Self::Ascii;
		}
		if is("UTF-8") || is("UTF8") {
			return Self::Utf8;
		}
		MsgCheck::open(charset).map_or(Self::Bytes, |check| Self::Other(Arc::new(check)))
	}
}

/// Upstream's `ic_chck`: a conversion from the locale charset to itself, which
/// converts what the charset accepts and stops at the first byte it does not.
pub(crate) struct MsgCheck {
	#[cfg(unix)]
	conv: sys::Converter,
}

impl MsgCheck {
	/// None when `iconv_open` refuses the charset (or the platform has no iconv).
	fn open(charset: &str) -> Option<Self> {
		#[cfg(unix)]
		return sys::Converter::open(charset, charset).ok().map(|conv| Self { conv });
		#[cfg(not(unix))]
		{
			let _ = charset;
			None
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
	/// locale: a shell whose locale search path is relative to a working
	/// directory no process can name (`child` is `None` here, as it is for a
	/// caller that has no child settings) has to say so, because silence
	/// there escapes every high-bit byte of a name the reference prints.
	#[cfg(unix)]
	#[test]
	fn an_unanswerable_lookup_is_reported() {
		let env = |k: &str| match k {
			"LC_ALL" => Some("en_US.ISO-8859-1".to_owned()),
			"LOCPATH" => Some("locales".to_owned()),
			_ => None,
		};
		let answer = locale_charset(&env, None);
		assert_eq!(answer.charset, "ISO-8859-1", "the name's own codeset is the fallback");
		let warning = answer.warning.expect("an unanswerable lookup is reported");
		assert!(warning.contains("en_US.ISO-8859-1"), "{warning}");
		// An answer libc did give carries no warning, whatever it is.
		let c = locale_charset(&|k: &str| (k == "LC_ALL").then(|| "C".to_owned()), None);
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
				let charset = locale_charset(&|k: &str| (k == "LC_ALL").then(|| name.to_owned()), None);
				assert_eq!(charset.charset, "UTF-8", "{name}");
			}
		}
		let c = locale_charset(&|k: &str| (k == "LC_ALL").then(|| "C".to_owned()), None);
		assert_eq!(c.charset, ascii_codeset());
	}

	/// `setlocale` picks `LC_ALL` over `LANG`. What a name the system has no
	/// data for yields is platform-specific: on Unix `setlocale` fails and
	/// leaves the C locale, so the charset is ASCII and a `LC_ALL=xx_YY.UTF-8`
	/// shell escapes high-bit bytes like rsync 3.5.1 does; Windows has no
	/// locale object to ask, so the name's own codeset is all there is.
	#[test]
	fn locale_charset_from_env() {
		let env = |pairs: &'static [(&'static str, &'static str)]| {
			move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned())
		};
		assert_eq!(locale_charset(&env(&[]), None).charset, ascii_codeset());
		assert_eq!(locale_charset(&env(&[("LANG", "C")]), None).charset, ascii_codeset());
		assert_eq!(
			locale_charset(&env(&[("LC_ALL", "C"), ("LANG", "en_US.UTF-8")]), None).charset,
			ascii_codeset()
		);
		let unknown = locale_charset(&env(&[("LC_ALL", "xx_YY.UTF-8")]), None).charset;
		#[cfg(unix)]
		assert_eq!(unknown, ascii_codeset());
		#[cfg(not(unix))]
		assert_eq!(unknown, "UTF-8");
		if let Some(installed) = utf8_locale_name() {
			let charset = locale_charset(&|k: &str| (k == "LC_CTYPE").then(|| installed.to_owned()), None).charset;
			assert!(matches!(MsgCharset::for_locale(&charset), MsgCharset::Utf8), "{charset}");
		}
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
