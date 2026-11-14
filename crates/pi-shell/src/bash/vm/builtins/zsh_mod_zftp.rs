//! zsh/zftp: the `zftp` builtin, a scriptable FTP client.
//!
//! The builtin never blocks: every network, terminal and file operation is
//! a [`ZftpOp`] probe ([`io`]), answered once and cached, and the builtin
//! runs again from scratch with the answers so far. The code below is
//! zftp.c's, straight-line; what the module keeps between commands (the
//! sessions, their connections' fds, the last reply) is a postcard record
//! ([`MiscKey::Zftp`]) read at the start of a command and written at its
//! end. zsh shares each session's status word with forked subshells
//! through a temporary file; here that file is a record of the root store
//! ([`MiscKey::ZftpStatus`]) every subshell reads and writes.
//!
//! `zftp_progress` and `zftp_chpwd` are shell functions called mid-command:
//! the builtin pushes the call as a frame and returns
//! [`Control::Resume`]; when the frame returns it runs again, replaying
//! its cached answers and skipping the calls already made
//! ([`Ctx::resumed`]). Parameter reads go through probes too, so a replay
//! sees what the first run saw.
//!
//! Ported from zsh 5.9 `Src/Modules/zftp.c` (MIT-style licence, Copyright
//! (c) 1998 Peter Stephenson and the zsh development group).

pub mod io;

use std::net::{IpAddr, SocketAddr};

use bstr::{BString, ByteSlice};
use serde::{Deserialize, Serialize};

use self::io::{Fail, SockInfo, XferSpec};
pub use self::io::{ZftpAns, ZftpLive, ZftpOp};
use super::{Control, Ctx, Need, Outcome, R, done, zsh_args::zx, zsh_mod_tcp as tcp};
use crate::bash::{
	diag::Diag,
	event::EventData,
	store::{Attrs, KeyBuf, MiscKey, Record, Var, VarValue},
	syntax::zsh::tok::metafy,
	vm::{
		exec::push_script,
		proc::{Probe, ProbeResult, ScriptKind},
		state::{self, Level},
		zsh::{arith, params},
	},
	zshopt::ZshOpt,
};

/// zftp's subcommand flags (`ZFTP_*`).
const CONN: u32 = 0x0001;
const LOGI: u32 = 0x0002;
const TBIN: u32 = 0x0004;
const TASC: u32 = 0x0008;
const NLST: u32 = 0x0010;
const DELE: u32 = 0x0020;
const SITE: u32 = 0x0040;
const APPE: u32 = 0x0080;
const HERE: u32 = 0x0100;
const CDUP: u32 = 0x0200;
const REST: u32 = 0x0400;
const RECV: u32 = 0x0800;
const TEST: u32 = 0x1000;
const SESS: u32 = 0x2000;

/// zsh `zftpcmdtab`: name, handler, fewest and most arguments (-1: no
/// limit), flags.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fun {
	Open,
	Params,
	Login,
	Test,
	Cd,
	Dir,
	Type,
	Mode,
	Local,
	GetPut,
	Delete,
	Mkdir,
	Rename,
	Quote,
	Close,
	Session,
	RmSession,
}

const CMDS: &[(&str, Fun, usize, i32, u32)] = &[
	("open", Fun::Open, 0, 4, 0),
	("params", Fun::Params, 0, 4, 0),
	("login", Fun::Login, 0, 3, CONN),
	("user", Fun::Login, 0, 3, CONN),
	("test", Fun::Test, 0, 0, TEST),
	("cd", Fun::Cd, 1, 1, CONN | LOGI),
	("cdup", Fun::Cd, 0, 0, CONN | LOGI | CDUP),
	("dir", Fun::Dir, 0, -1, CONN | LOGI),
	("ls", Fun::Dir, 0, -1, CONN | LOGI | NLST),
	("type", Fun::Type, 0, 1, CONN | LOGI),
	("ascii", Fun::Type, 0, 0, CONN | LOGI | TASC),
	("binary", Fun::Type, 0, 0, CONN | LOGI | TBIN),
	("mode", Fun::Mode, 0, 1, CONN | LOGI),
	("local", Fun::Local, 0, -1, HERE),
	("remote", Fun::Local, 1, -1, CONN | LOGI),
	("get", Fun::GetPut, 1, -1, CONN | LOGI | RECV),
	("getat", Fun::GetPut, 2, 2, CONN | LOGI | RECV | REST),
	("put", Fun::GetPut, 1, -1, CONN | LOGI),
	("putat", Fun::GetPut, 2, 2, CONN | LOGI | REST),
	("append", Fun::GetPut, 1, -1, CONN | LOGI | APPE),
	("appendat", Fun::GetPut, 2, 2, CONN | LOGI | APPE | REST),
	("delete", Fun::Delete, 1, -1, CONN | LOGI),
	("mkdir", Fun::Mkdir, 1, 1, CONN | LOGI),
	("rmdir", Fun::Mkdir, 1, 1, CONN | LOGI | DELE),
	("rename", Fun::Rename, 2, 2, CONN | LOGI),
	("quote", Fun::Quote, 1, -1, CONN),
	("site", Fun::Quote, 1, -1, CONN | SITE),
	("close", Fun::Close, 0, 0, CONN),
	("quit", Fun::Close, 0, 0, CONN),
	("session", Fun::Session, 0, 1, SESS),
	("rmsession", Fun::RmSession, 0, 1, SESS),
];

/// zsh `zfparams`: the parameters a closed connection unsets and a session
/// switch saves and restores.
const ZFPARAMS: [&str; 9] = [
	"ZFTP_HOST",
	"ZFTP_PORT",
	"ZFTP_IP",
	"ZFTP_SYSTEM",
	"ZFTP_USER",
	"ZFTP_ACCOUNT",
	"ZFTP_PWD",
	"ZFTP_TYPE",
	"ZFTP_MODE",
];

/// Session status bits (`ZFST_*`).
const ST_IMAG: i32 = 0x0001;
const ST_TMSK: i32 = 0x0001;
const ST_TBIT: i32 = 1;
const ST_BLOC: i32 = 0x0004;
const ST_MMSK: i32 = 0x0004;
const ST_LOGI: i32 = 0x0008;
const ST_SYST: i32 = 0x0010;
const ST_NOPS: i32 = 0x0020;
const ST_NOSZ: i32 = 0x0040;
const ST_TRSZ: i32 = 0x0080;
const ST_CLOS: i32 = 0x0100;

/// Preferences (`ZFPF_*`).
const PF_SNDP: u8 = 0x01;
const PF_PASV: u8 = 0x02;
const PF_DUMB: u8 = 0x04;

/// `has_size`/`has_mdtm` (`ZFCP_*`).
const CP_UNKN: u8 = 0;
const CP_YUPP: u8 = 1;
const CP_NOPE: u8 = 2;

/// The control connection of a session (zsh `Tcp_session`).
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Ctl {
	/// Its fd (≥ 10).
	fd:   i32,
	/// `getsockname`.
	sock: Option<SocketAddr>,
	/// `getpeername`.
	peer: Option<SocketAddr>,
}

/// One session (zsh `struct zftp_session`), with its status word.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Session {
	name:       BString,
	/// Saved values of [`ZFPARAMS`] while another session is current.
	params:     Vec<Option<BString>>,
	/// `zftp params`.
	userparams: Option<Vec<BString>>,
	control:    Option<Ctl>,
	/// The data connection.
	dfd:        Option<i32>,
	has_size:   u8,
	has_mdtm:   u8,
	/// `zfstatusp[n]`.
	status:     i32,
}

impl Session {
	fn new(name: &[u8]) -> Self {
		Self {
			name:       name.into(),
			params:     vec![None; ZFPARAMS.len()],
			userparams: None,
			control:    None,
			dfd:        None,
			has_size:   CP_UNKN,
			has_mdtm:   CP_UNKN,
			status:     0,
		}
	}
}

/// The module's globals (zftp.c's statics), kept between commands.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct State {
	sessions:    Vec<Session>,
	/// `zfsessno`.
	cur:         usize,
	/// `zfnopen`.
	nopen:       u32,
	/// `zfprefs`.
	prefs:       u8,
	/// The status file (`zfstatfd`): its id in the shared record.
	statfd:      Option<u64>,
	lastmsg:     BString,
	lastcode:    i32,
	lastcodestr: [u8; 3],
	/// `zcfinish`.
	cfinish:     u8,
	/// `zfclosing`.
	closing:     bool,
	/// `zfdrrrring`: a timeout went off.
	drrrring:    bool,
}

impl State {
	/// The globals after `boot_`: the session `default`, preferences `PS`.
	fn booted() -> Self {
		Self {
			sessions:    vec![Session::new(b"default")],
			cur:         0,
			nopen:       0,
			prefs:       PF_SNDP | PF_PASV,
			statfd:      None,
			lastmsg:     BString::default(),
			lastcode:    0,
			lastcodestr: *b"000",
			cfinish:     0,
			closing:     false,
			drrrring:    false,
		}
	}
}

/// The shared status files (zsh `zfstatfd`, one per tree of shells that
/// opened a first connection): id, the shell that made it, status words.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Shared {
	next:  u64,
	files: Vec<(u64, u32, Vec<i32>)>,
}

/// Why a run stops early.
enum Stop {
	/// A probe to answer, or a store failure.
	Need(Need),
	/// A hook function was pushed: run again when it returns.
	Hook,
}

impl From<Need> for Stop {
	fn from(n: Need) -> Self {
		Self::Need(n)
	}
}

type Z<T> = Result<T, Stop>;

/// One run of the builtin.
struct Zf<'r, 'a, 'c> {
	ctx:      &'r mut Ctx<'a, 'c>,
	/// Probes asked so far.
	seq:      u32,
	/// Hook calls reached so far.
	hooks:    u32,
	/// Hooks cannot run (module unload): report them.
	no_hooks: bool,
	st:       State,
	shared:   Shared,
}

/// zsh `idigit`.
fn digit(c: Option<&u8>) -> bool {
	c.is_some_and(u8::is_ascii_digit)
}

/// zsh `zstrtol(s, NULL, 10)`: leading blanks, a sign, digits.
fn zstrtol(s: &[u8]) -> i64 {
	zstrtol_end(s).0
}

/// zsh `zstrtol(s, &end, 10)`: the number and where it ended.
fn zstrtol_end(s: &[u8]) -> (i64, usize) {
	let mut i = 0;
	while matches!(s.get(i), Some(b' ' | b'\t')) {
		i += 1;
	}
	let neg = match s.get(i) {
		Some(b'-') => {
			i += 1;
			true
		},
		Some(b'+') => {
			i += 1;
			false
		},
		_ => false,
	};
	let mut n: i64 = 0;
	while let Some(&c) = s.get(i).filter(|c| c.is_ascii_digit()) {
		n = n.wrapping_mul(10).wrapping_add(i64::from(c - b'0'));
		i += 1;
	}
	(if neg { n.wrapping_neg() } else { n }, i)
}

/// `atoi`-like parse of a `%d` at the start of `s` (after blanks): the
/// value and the rest, or `None` without digits.
fn scan_int(s: &[u8]) -> Option<(i64, &[u8])> {
	let mut i = 0;
	while s.get(i).is_some_and(u8::is_ascii_whitespace) {
		i += 1;
	}
	let start = i;
	if matches!(s.get(i), Some(b'-' | b'+')) {
		i += 1;
	}
	let digits = i;
	while s.get(i).is_some_and(u8::is_ascii_digit) {
		i += 1;
	}
	(i > digits).then(|| (zstrtol(&s[start..i]), &s[i..]))
}

/// `gmtime` + `"%Y%m%d%H%M%S"`.
fn mdtm(secs: i64) -> BString {
	let days = secs.div_euclid(86400);
	let rem = secs.rem_euclid(86400);
	// Howard Hinnant's civil-from-days.
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = yoe + era * 400 + i64::from(m <= 2);
	BString::from(format!(
		"{y:04}{m:02}{d:02}{:02}{:02}{:02}",
		rem / 3600,
		rem % 3600 / 60,
		rem % 60
	))
}

impl<'r, 'a, 'c> Zf<'r, 'a, 'c> {
	/// Read the module state as the command found it.
	fn start(ctx: &'r mut Ctx<'a, 'c>) -> Z<Self> {
		let mut z = Self {
			ctx,
			seq: 0,
			hooks: 0,
			no_hooks: false,
			st: State::booted(),
			shared: Shared::default(),
		};
		if let ZftpAns::Start { state, shared } = z.ask(ZftpOp::Start)? {
			if let Some(st) = state.and_then(|b| postcard::from_bytes::<State>(&b).ok()) {
				z.st = st;
			}
			if let Some(sh) = shared.and_then(|b| postcard::from_bytes::<Shared>(&b).ok()) {
				z.shared = sh;
			}
		}
		Ok(z)
	}

	/// Store the module state.
	fn commit(&mut self) {
		if let Ok(bytes) = postcard::to_stdvec(&self.st) {
			self
				.ctx
				.store_record(KeyBuf::Misc(MiscKey::Zftp), Some(Record::Misc(bytes.into())));
		}
	}

	/// Store the shared status files (in the root: every subshell sees them).
	fn commit_shared(&mut self) {
		if let Ok(bytes) = postcard::to_stdvec(&self.shared) {
			self.ctx.k.root.set_record(
				self.ctx.cx.store,
				KeyBuf::Misc(MiscKey::ZftpStatus),
				Some(Record::Misc(bytes.into())),
			);
		}
	}

	// ---- probes and output ---------------------------------------------

	fn ask(&mut self, op: ZftpOp) -> Z<ZftpAns> {
		let seq = self.seq;
		self.seq += 1;
		match self.ctx.probe(Probe::Zftp { seq, op: Box::new(op) })? {
			ProbeResult::Zftp(a) => Ok(*a),
			_ => Ok(ZftpAns::Done),
		}
	}

	/// Write to an fd (zsh's stdio output to stdout/stderr).
	fn out(&mut self, fd: i32, data: impl Into<BString>) -> Z<()> {
		self.ask(ZftpOp::Out { fd, data: data.into() })?;
		Ok(())
	}

	/// zsh `zwarnnam(name, msg)`.
	fn warn(&mut self, name: &str, msg: impl Into<String>) -> Z<()> {
		let msg: String = msg.into();
		let d = Diag::Usage { msg: msg.into() }.by(name.to_owned());
		let bytes = self
			.ctx
			.k
			.render_quiet(self.ctx.cx, self.ctx.vp, self.ctx.line, &d);
		self.out(2, bytes)
	}

	/// zsh `getsparam`.
	fn getsparam(&mut self, name: &str) -> Z<Option<BString>> {
		Ok(match self.ask(ZftpOp::Param(name.into()))? {
			ZftpAns::Text(t) => t,
			_ => None,
		})
	}

	/// zsh `getiparam`: the value through the math code (0 when unset).
	fn getiparam(&mut self, name: &str) -> Z<i64> {
		let Some(text) = self.getsparam(name)? else {
			return Ok(0);
		};
		match zx(self.ctx, |ex| arith::mathevali(ex, &metafy(&text)))? {
			Ok(n) => Ok(n),
			Err(d) => {
				let bytes = self
					.ctx
					.k
					.render_quiet(self.ctx.cx, self.ctx.vp, self.ctx.line, &d);
				self.out(2, bytes)?;
				Ok(0)
			},
		}
	}

	/// `ZFTP_TMOUT` in seconds for a timer (negative: none).
	fn tmout(&mut self) -> Z<u32> {
		Ok(u32::try_from(self.getiparam("ZFTP_TMOUT")?).unwrap_or(0))
	}

	/// zsh `getshfunc(name) != NULL`.
	fn func(&mut self, name: &str) -> Z<bool> {
		Ok(matches!(self.ask(ZftpOp::Func(name.into()))?, ZftpAns::Flag(true)))
	}

	/// zsh `doshfunc(getshfunc(name), NULL, 1)` when the function exists:
	/// push the call and stop; a replay skips calls already made.
	fn hook(&mut self, name: &str) -> Z<()> {
		if !self.func(name)? {
			return Ok(());
		}
		if self.no_hooks {
			let what = format!("`{name}' called while unloading zsh/zftp");
			let bytes =
				self
					.ctx
					.k
					.render_quiet(self.ctx.cx, self.ctx.vp, self.ctx.line, &Diag::Unsupported {
						what: what.into(),
					});
			return self.out(2, bytes);
		}
		let k = self.hooks;
		self.hooks += 1;
		if k < self.ctx.resumed {
			return Ok(());
		}
		self.commit();
		let mut src = Vec::with_capacity(name.len() + 3);
		src.push(b'\'');
		src.extend_from_slice(name.as_bytes());
		src.extend_from_slice(b"'\n");
		push_script(self.ctx.vp, &src, self.ctx.line, ScriptKind::Eval);
		self
			.ctx
			.k
			.emit_op(self.ctx.cx, self.ctx.vp, 0, EventData::EvalEnter);
		Err(Stop::Hook)
	}

	// ---- parameters -----------------------------------------------------

	/// zsh `zfsetparam`: create `name` (read-only when `ro`) if it is not
	/// set, else set it if it has the type, bypassing read-only.
	fn setparam(&mut self, name: &str, val: &[u8], int: bool, ro: bool, ifunset: bool) -> Z<()> {
		let cur = state::lookup(&self.ctx.k.root, self.ctx.cx.store, self.ctx.vp, name.as_bytes())
			.map_err(|e| Stop::Need(Need::Store(e)))?
			.cloned();
		let (attrs, level) = match cur {
			Some(v) if !v.attrs.contains(Attrs::INVISIBLE) => {
				if ifunset {
					return Ok(());
				}
				let is_int = v.attrs.contains(Attrs::INTEGER);
				let is_float =
					v.attrs.contains(Attrs::ZSH_FLOAT_E) || v.attrs.contains(Attrs::ZSH_FLOAT_F);
				if !matches!(v.value, VarValue::Str(_)) || is_int != int || (!int && is_float) {
					// zsh: "parameters are funny, you just never know".
					return Ok(());
				}
				(v.attrs, Level::Dynamic)
			},
			unset => {
				let mut attrs = if int { Attrs::INTEGER } else { Attrs::NONE };
				if ro {
					attrs = attrs.with(Attrs::READONLY);
				}
				let level = if unset.is_some() {
					Level::Dynamic
				} else {
					Level::Global
				};
				(attrs, level)
			},
		};
		self
			.ctx
			.set_var(name.as_bytes(), Some(Var::scalar(val, attrs)), level);
		Ok(())
	}

	fn setsparam(&mut self, name: &str, val: &[u8]) -> Z<()> {
		self.setparam(name, val, false, true, false)
	}

	fn setiparam(&mut self, name: &str, val: i64) -> Z<()> {
		self.setparam(name, val.to_string().as_bytes(), true, true, false)
	}

	/// zsh `zfunsetparam`: unset `name`, read-only or not.
	fn unsetparam(&mut self, name: &str) -> Z<()> {
		let cur = state::lookup(&self.ctx.k.root, self.ctx.cx.store, self.ctx.vp, name.as_bytes())
			.map_err(|e| Stop::Need(Need::Store(e)))?
			.cloned();
		let Some(v) = cur else {
			return Ok(());
		};
		if v.attrs.contains(Attrs::READONLY) {
			let v = Var { attrs: v.attrs.without(Attrs::READONLY), value: v.value };
			self.ctx.set_var(name.as_bytes(), Some(v), Level::Dynamic);
		}
		let _ = zx(self.ctx, |ex| params::unsetparam(ex, name.as_bytes()))?;
		Ok(())
	}

	// ---- session helpers -------------------------------------------------

	fn sess(&mut self) -> &mut Session {
		&mut self.st.sessions[self.st.cur]
	}

	fn status(&self) -> i32 {
		self.st.sessions[self.st.cur].status
	}

	fn set_status(&mut self, s: i32) {
		self.sess().status = s;
	}

	fn control_fd(&self) -> Option<i32> {
		self.st.sessions[self.st.cur].control.as_ref().map(|c| c.fd)
	}

	/// The status file's words.
	fn statfile(&mut self) -> Option<&mut Vec<i32>> {
		let id = self.st.statfd?;
		self
			.shared
			.files
			.iter_mut()
			.find(|f| f.0 == id)
			.map(|f| &mut f.2)
	}

	/// Write the current session's status word to the status file.
	fn write_status(&mut self) {
		let (cur, word) = (self.st.cur, self.status());
		let Some(words) = self.statfile() else {
			return;
		};
		if words.len() <= cur {
			words.resize(cur + 1, 0);
		}
		words[cur] = word;
		self.commit_shared();
	}

	/// List the control connection in zsh/net/tcp's session table (zsh
	/// `tcp_socket(…, ZTCP_ZFTP)`): `ztcp -L` shows it as `Z`. Replays add
	/// it once.
	fn tcp_add(&mut self, ctl: &Ctl) -> Z<()> {
		let zero = SocketAddr::from(([0, 0, 0, 0], 0));
		let mut list = tcp::sessions(self.ctx)?;
		list.retain(|s| s.fd != ctl.fd);
		list.push(tcp::Session {
			fd:    ctl.fd,
			kind:  tcp::SessionKind::Zftp,
			local: ctl.sock.unwrap_or(zero),
			peer:  ctl.peer.unwrap_or(zero),
		});
		tcp::store_sessions(self.ctx, &list);
		Ok(())
	}

	/// Drop the control connection from the tcp session table (`tcp_close`;
	/// the fd itself is closed by a probe).
	fn tcp_remove(&mut self, fd: i32) -> Z<()> {
		let mut list = tcp::sessions(self.ctx)?;
		let before = list.len();
		list.retain(|s| s.fd != fd);
		if list.len() != before {
			tcp::store_sessions(self.ctx, &list);
		}
		Ok(())
	}

	// ---- the control connection -------------------------------------------

	/// zsh `zfgetline` + the timeout's report: the line and whether the
	/// connection ended.
	fn getline(&mut self, fd: i32, tmout: u32) -> Z<(BString, bool)> {
		self.st.drrrring = false;
		self.st.cfinish = 0;
		match self.ask(ZftpOp::Line { fd, timeout: tmout })? {
			ZftpAns::Line { timed_out: true, .. } => {
				self.st.drrrring = true;
				self.warn("zftp", "timeout getting response")?;
				Ok((BString::default(), false))
			},
			ZftpAns::Line { text, eof, .. } => {
				if eof {
					self.st.cfinish = 2;
				} else {
					self.st.cfinish = 1;
				}
				Ok((text, eof))
			},
			_ => Ok((BString::default(), true)),
		}
	}

	/// zsh `zfgetmsg`: read a whole reply; the first digit of its code, or
	/// 6 when nothing more can be done.
	fn getmsg(&mut self) -> Z<i32> {
		let Some(fd) = self.control_fd() else {
			return Ok(6);
		};
		self.st.lastmsg.clear();
		let tmout = self.tmout()?;
		let (line, _) = self.getline(fd, tmout)?;
		if self.st.drrrring || !digit(line.first()) || !digit(line.get(1)) || !digit(line.get(2)) {
			// A timeout, or not talking FTP.
			self.st.cfinish = 2;
			if !self.st.closing {
				self.zfclose(false)?;
			}
			self.st.lastmsg.clear();
			self.st.lastcodestr = *b"000";
			self.setsparam("ZFTP_REPLY", b"")?;
			return Ok(6);
		}
		self.st.lastcodestr = [line[0], line[1], line[2]];
		self.st.lastcode = zstrtol(&line[..3]) as i32;
		let code = self.st.lastcodestr;
		self.setsparam("ZFTP_CODE", &code)?;
		let mut stopit = line.get(3) != Some(&b'-');
		// zsh steps past the separator even at the end of the line.
		let mut ptr: BString = line.get(4..).unwrap_or_default().into();
		let verbose = self.getsparam("ZFTP_VERBOSE")?.unwrap_or_default();
		let mut printing = 0;
		if verbose.contains(&code[0]) {
			// The whole reply verbatim.
			printing = 1;
			let mut l = line.clone();
			l.push(b'\n');
			self.out(2, l)?;
		} else if verbose.contains(&b'0') && !stopit {
			// The lines of a multi-line reply without their codes.
			printing = 2;
			let mut l = ptr.clone();
			l.push(b'\n');
			self.out(2, l)?;
		}
		let mut last = line;
		while self.st.cfinish != 2 && !stopit {
			let (line, _) = self.getline(fd, tmout)?;
			if self.st.drrrring {
				last = BString::default();
				ptr = BString::default();
				break;
			}
			ptr = line.clone();
			if line.len() >= 3 && line[..3] == code {
				match line.get(3) {
					Some(b' ') => {
						stopit = true;
						ptr = BString::from(&line[4..]);
					},
					Some(b'-') => ptr = BString::from(&line[4..]),
					_ => {},
				}
			} else if line.starts_with(b"    ") {
				ptr = BString::from(&line[4..]);
			}
			if printing == 2 {
				if !stopit {
					let mut l = ptr.clone();
					l.push(b'\n');
					self.out(2, l)?;
				}
			} else if printing == 1 {
				let mut l = line.clone();
				l.push(b'\n');
				self.out(2, l)?;
			}
			last = line;
		}
		self.st.lastmsg = ptr;
		self.setsparam("ZFTP_REPLY", &last)?;
		if (self.st.cfinish == 2 || self.st.lastcode == 421) && !self.st.closing {
			self.st.cfinish = 2;
			self.zfclose(false)?;
			self.warn("zftp", "remote server has closed connection")?;
			return Ok(6);
		}
		if self.st.lastcode == 530 {
			// Not logged in.
			return Ok(6);
		}
		if self.st.lastcode == 120 {
			let msg = format!("delay expected, waiting: {}", self.st.lastmsg.to_str_lossy());
			self.warn("zftp", msg)?;
			return self.getmsg();
		}
		Ok(i32::from(code[0]) - i32::from(b'0'))
	}

	/// zsh `zfsendcmd`: send a command line (with its `\r\n`) and read the
	/// reply.
	fn sendcmd(&mut self, cmd: &[u8]) -> Z<i32> {
		let Some(fd) = self.control_fd() else {
			return Ok(6);
		};
		let tmout = self.tmout()?;
		self.st.drrrring = false;
		match self.ask(ZftpOp::Write { fd, data: cmd.into(), timeout: tmout })? {
			ZftpAns::Wrote(Ok(n)) if n > 0 => {},
			ZftpAns::Wrote(Err(Fail { timed_out: true, .. })) => {
				self.st.drrrring = true;
				self.warn("zftp", "timeout sending message")?;
				return Ok(6);
			},
			ZftpAns::Wrote(Err(f)) => {
				let msg = format!("failure sending control message: {}", f.text());
				self.warn("zftp send", msg)?;
				return Ok(6);
			},
			_ => {
				self.warn("zftp send", "failure sending control message: undefined error: 0")?;
				return Ok(6);
			},
		}
		self.getmsg()
	}

	// ---- data connections -------------------------------------------------

	/// zsh `zfclosedata`.
	fn closedata(&mut self) -> Z<()> {
		if let Some(fd) = self.sess().dfd.take() {
			self.ask(ZftpOp::Close { fd })?;
		}
		Ok(())
	}

	/// zsh `zfopendata`: `Some(passive)` when the data connection is set up.
	fn opendata(&mut self, name: &str) -> Z<Option<bool>> {
		if self.st.prefs & (PF_SNDP | PF_PASV) == 0 {
			self.warn(name, "Must set preference S or P to transfer data")?;
			return Ok(None);
		}
		let Some(ctl) = self.sess().control.clone() else {
			return Ok(None);
		};
		let v6 = ctl.peer.is_some_and(|p| p.is_ipv6());
		if self.status() & ST_NOPS == 0 && self.st.prefs & PF_PASV != 0 {
			let psv: &[u8] = if v6 { b"EPSV\r\n" } else { b"PASV\r\n" };
			if self.sendcmd(psv)? == 6 {
				return Ok(None);
			}
			if (500..=504).contains(&self.st.lastcode) {
				// Back to sendport mode, if the preferences allow it.
				let s = self.status() | ST_NOPS;
				self.set_status(s);
				self.closedata()?;
				return self.opendata(name);
			}
			let msg = self.st.lastmsg.clone();
			let addr = if v6 {
				match epsv_port(&msg) {
					Some(port) => ctl.peer.map(|p| SocketAddr::new(p.ip(), port)),
					None => None,
				}
				.ok_or("EPSV")
			} else {
				pasv_addr(&msg).ok_or("PASV")
			};
			let addr = match addr {
				Ok(a) => a,
				Err(what) => {
					self.warn(name, format!("bad response to {what}: {}", msg.to_str_lossy()))?;
					self.closedata()?;
					return Ok(None);
				},
			};
			match self.ask(ZftpOp::Connect { addr, deadline: None })? {
				ZftpAns::Sock(Ok(SockInfo { fd, .. })) => self.sess().dfd = Some(fd),
				ZftpAns::Sock(Err(f)) => {
					self.warn(name, format!("connect failed: {}", f.text()))?;
					self.closedata()?;
					return Ok(None);
				},
				_ => return Ok(None),
			}
			return Ok(Some(true));
		}
		if self.st.prefs & PF_SNDP == 0 {
			self.warn(name, "only sendport mode available for data")?;
			return Ok(None);
		}
		let Some(local) = ctl.sock else {
			self.warn(name, "failure on data socket: getsockname: bad file descriptor")?;
			return Ok(None);
		};
		let bind = SocketAddr::new(local.ip(), 0);
		let (fd, addr) = match self.ask(ZftpOp::Listen { addr: bind })? {
			ZftpAns::Listen(Ok(SockInfo { fd, local: Some(addr), .. })) => (fd, addr),
			ZftpAns::Listen(Ok(SockInfo { fd, local: None, .. })) => {
				self.ask(ZftpOp::Close { fd })?;
				self.warn(name, "failure on data socket: getsockname: bad file descriptor")?;
				return Ok(None);
			},
			ZftpAns::Listen(Err((stage, f))) => {
				let msg = match stage {
					0 => format!("can't get data socket: {}", f.text()),
					3 => format!("failure on data socket: listen: {}", f.text()),
					2 => format!("failure on data socket: getsockname: {}", f.text()),
					_ => format!("failure on data socket: bind: {}", f.text()),
				};
				self.warn(name, msg)?;
				return Ok(None);
			},
			_ => return Ok(None),
		};
		self.sess().dfd = Some(fd);
		let portcmd = match addr {
			SocketAddr::V6(a) => format!("EPRT |2|{}|{}|\r\n", a.ip(), a.port()),
			SocketAddr::V4(a) => {
				let o = a.ip().octets();
				let p = a.port().to_be_bytes();
				format!("PORT {},{},{},{},{},{}\r\n", o[0], o[1], o[2], o[3], p[0], p[1])
			},
		};
		if self.sendcmd(portcmd.as_bytes())? >= 5 {
			self.warn(name, "port command failed")?;
			self.closedata()?;
			return Ok(None);
		}
		Ok(Some(false))
	}

	/// zsh `zfgetdata`: open the data connection and send `cmd` (after
	/// `rest`); `true` on failure.
	fn getdata(&mut self, name: &str, rest: Option<&[u8]>, cmd: &[u8], getsize: bool) -> Z<bool> {
		let Some(passive) = self.opendata(name)? else {
			return Ok(true);
		};
		if let Some(rest) = rest
			&& self.sendcmd(rest)? > 3
		{
			self.closedata()?;
			return Ok(true);
		}
		if self.sendcmd(cmd)? > 2 {
			self.closedata()?;
			return Ok(true);
		}
		if getsize || (self.status() & ST_TRSZ == 0 && cmd.starts_with(b"RETR")) {
			// "Opening data connection for x (1234567 bytes)": no SIZE
			// needed next time.
			let s = self.status() | ST_NOSZ | ST_TRSZ;
			self.set_status(s);
			let msg = self.st.lastmsg.clone();
			if let Some(mut p) = msg.find("bytes") {
				while p > 0 && !msg[p].is_ascii_digit() {
					p -= 1;
				}
				while p > 0 && msg[p - 1].is_ascii_digit() {
					p -= 1;
				}
				if msg[p].is_ascii_digit() {
					let s = self.status() & !ST_NOSZ;
					self.set_status(s);
					if getsize {
						self.setiparam("ZFTP_SIZE", zstrtol(&msg[p..]))?;
					}
				}
			}
		}
		if !passive {
			let Some(lfd) = self.sess().dfd.take() else {
				return Ok(true);
			};
			match self.ask(ZftpOp::Accept { fd: lfd })? {
				ZftpAns::Sock(Ok(SockInfo { fd, .. })) => self.sess().dfd = Some(fd),
				ZftpAns::Sock(Err(f)) => {
					self.warn(name, format!("unable to accept data: {}", f.text()))?;
					return Ok(true);
				},
				_ => return Ok(true),
			}
		}
		Ok(false)
	}

	/// zsh `zfsenddata`: move the data, report progress, read the
	/// transfer's reply; `true` on failure.
	fn senddata(&mut self, name: &str, recv: bool, progress: bool, startat: i64) -> Z<bool> {
		let mut sofar = 0;
		let mut last = if progress && self.func("zftp_progress")? {
			// The start: ZFTP_COUNT is 0.
			self.hook("zftp_progress")?;
			sofar = startat;
			startat
		} else {
			0
		};
		let Some(data_fd) = self.sess().dfd else {
			return Ok(true);
		};
		let tmout = self.tmout()?;
		let st = self.status();
		let ascii = (st >> ST_TBIT) & ST_TMSK == 0;
		let block = st & ST_MMSK == ST_BLOC;
		let interact = self.ctx.zsh_option(ZshOpt::Interactive)?;
		let mut eof = false;
		let mut ret = loop {
			let one = progress && self.func("zftp_progress")?;
			let spec = XferSpec {
				recv,
				data_fd,
				fromasc: recv && ascii,
				toasc: !recv && ascii,
				block,
				tmout,
				interact,
				one,
				eof,
			};
			let out = match self.ask(ZftpOp::Xfer(spec))? {
				ZftpAns::Xfer(out) => out,
				_ => io::XferOut { ret: 1, done: true, ..io::XferOut::default() },
			};
			for (full, msg) in &out.msgs {
				self.warn(if *full { name } else { "zftp" }, msg.clone())?;
			}
			sofar += out.n;
			eof = out.eof;
			if out.ret == 0 && sofar != last && one {
				self.setiparam("ZFTP_COUNT", sofar)?;
				self.hook("zftp_progress")?;
				last = sofar;
			}
			if out.done {
				break out.ret;
			}
		};
		// A timeout here was on the data connection: the control one stays.
		self.st.drrrring = false;
		if ret == 0 && !recv && block {
			// The end-of-file block.
			let hdr = vec![io::HD_EOFB, 0, 0];
			match self.ask(ZftpOp::Write { fd: data_fd, data: hdr.into(), timeout: tmout })? {
				ZftpAns::Wrote(Ok(3)) => {},
				ZftpAns::Wrote(Ok(_)) => self.warn("zftp", "failure writing FTP block header")?,
				// zsh carries on after the timeout's report as if the header
				// went out; the connection closes at the end of the command.
				ZftpAns::Wrote(Err(Fail { timed_out: true, .. })) => {
					self.st.drrrring = true;
					self.warn("zftp", "timeout on network write")?;
				},
				_ => {
					self.warn("zftp", "failure writing FTP block header")?;
					ret = 1;
				},
			}
		}
		if ret > 1 {
			// Something went wrong locally: abort the transfer (RFC 959).
			if ret == 2 {
				self.warn(name, "aborting data transfer...")?;
			}
			if let Some(fd) = self.control_fd() {
				self.ask(ZftpOp::Urgent { fd })?;
			}
			self.sendcmd(b"ABOR\r\n")?;
			if self.st.lastcode != 226 {
				ret = 1;
			}
		}
		self.closedata()?;
		if self.getmsg()? > 2 {
			ret = 1;
		}
		Ok(ret != 0)
	}

	// ---- files ---------------------------------------------------------------

	/// zsh `zfsettype`: make the transfer type current.
	fn settype(&mut self, ty: i32) -> Z<bool> {
		let st = self.status();
		if ty & ST_TMSK == (st >> ST_TBIT) & ST_TMSK {
			return Ok(false);
		}
		let cmd: &[u8] = if ty & ST_TMSK == 0 {
			b"TYPE A\r\n"
		} else {
			b"TYPE I\r\n"
		};
		if self.sendcmd(cmd)? > 2 {
			return Ok(true);
		}
		let st = (self.status() & !(ST_TMSK << ST_TBIT)) | (ty << ST_TBIT);
		self.set_status(st);
		Ok(false)
	}

	/// zsh `zfstats`: size and modification time of a remote file, or of a
	/// local one (`fstat(0)` with `fd0`): 0 fine, 1 failed, 2 the server
	/// cannot tell.
	fn stats(
		&mut self,
		fnam: &[u8],
		remote: bool,
		want_mdtm: bool,
		fd0: bool,
	) -> Z<(i32, i64, Option<BString>)> {
		let mut sz = -1;
		let mut mt = None;
		if remote {
			let (hs, hm) = (self.sess().has_size, self.sess().has_mdtm);
			if hs == CP_NOPE || (hm == CP_NOPE && want_mdtm) {
				return Ok((2, -1, None));
			}
			let ty = self.status() & ST_TMSK;
			self.settype(ty)?;
			let mut cmd = BString::from("SIZE ");
			cmd.extend_from_slice(fnam);
			cmd.extend_from_slice(b"\r\n");
			if self.sendcmd(&cmd)? == 6 {
				return Ok((1, -1, None));
			} else if self.st.lastcode < 300 {
				sz = zstrtol(&self.st.lastmsg);
				self.sess().has_size = CP_YUPP;
			} else if (500..=504).contains(&self.st.lastcode) {
				self.sess().has_size = CP_NOPE;
				return Ok((2, -1, None));
			} else if self.st.lastcode == 550 {
				return Ok((1, -1, None));
			}
			if want_mdtm {
				let mut cmd = BString::from("MDTM ");
				cmd.extend_from_slice(fnam);
				cmd.extend_from_slice(b"\r\n");
				if self.sendcmd(&cmd)? == 6 {
					return Ok((1, sz, None));
				} else if self.st.lastcode < 300 {
					mt = Some(self.st.lastmsg.clone());
					self.sess().has_mdtm = CP_YUPP;
				} else if (500..=504).contains(&self.st.lastcode) {
					self.sess().has_mdtm = CP_NOPE;
					return Ok((2, sz, None));
				} else if self.st.lastcode == 550 {
					return Ok((1, sz, None));
				}
			}
		} else {
			let path = (!fd0).then(|| crate::bash::vm::probe::absolute(&self.ctx.vp.cwd, fnam));
			let Some((size, mtime)) = (match self.ask(ZftpOp::Stat { path })? {
				ZftpAns::Stat(s) => s,
				_ => None,
			}) else {
				return Ok((1, -1, None));
			};
			sz = size;
			if want_mdtm {
				mt = Some(mdtm(mtime));
			}
		}
		Ok((0, sz, mt))
	}

	/// zsh `zfstarttrans`.
	fn starttrans(&mut self, nam: &[u8], recv: bool, sz: i64) -> Z<()> {
		if sz > 0 {
			self.setiparam("ZFTP_SIZE", sz)?;
		}
		self.setsparam("ZFTP_FILE", nam)?;
		self.setsparam("ZFTP_TRANSFER", if recv { b"G" } else { b"P" })?;
		self.setiparam("ZFTP_COUNT", 0)
	}

	/// zsh `zfendtrans`.
	fn endtrans(&mut self) -> Z<()> {
		for p in ["ZFTP_SIZE", "ZFTP_FILE", "ZFTP_TRANSFER", "ZFTP_COUNT"] {
			self.unsetparam(p)?;
		}
		Ok(())
	}

	/// zsh `zfgetcwd`: ask the server for the directory into `ZFTP_PWD`.
	fn getcwd(&mut self) -> Z<i32> {
		if self.st.prefs & PF_DUMB != 0 {
			return Ok(1);
		}
		if self.sendcmd(b"PWD\r\n")? > 2 {
			self.unsetparam("ZFTP_PWD")?;
			return Ok(1);
		}
		let msg = self.st.lastmsg.clone();
		let mut p = 0;
		while msg.get(p) == Some(&b' ') {
			p += 1;
		}
		if p >= msg.len() {
			return Ok(1);
		}
		let endc = if msg[p] == b'"' {
			p += 1;
			b'"'
		} else {
			b' '
		};
		let end = msg[p..]
			.iter()
			.position(|&c| c == endc)
			.map_or(msg.len(), |e| p + e);
		self.setsparam("ZFTP_PWD", &msg[p..end])?;
		self.hook("zftp_chpwd")?;
		Ok(0)
	}

	/// zsh `zfclose`: end the session's connection; with `leaveparams` the
	/// parameters (and `zftp_chpwd`) are not this session's.
	fn zfclose(&mut self, leaveparams: bool) -> Z<()> {
		let Some(ctl) = self.sess().control.clone() else {
			return Ok(());
		};
		self.st.closing = true;
		if self.st.cfinish != 2 {
			self.sendcmd(b"QUIT\r\n")?;
		}
		self.st.nopen = self.st.nopen.saturating_sub(1);
		self.sess().control = None;
		self.tcp_remove(ctl.fd)?;
		self.ask(ZftpOp::Close { fd: ctl.fd })?;
		if self.st.statfd.is_some() {
			let s = self.status() | ST_CLOS;
			self.set_status(s);
			if self.st.nopen == 0 {
				// The final status, in case this is a subshell.
				self.write_status();
				let id = self.st.statfd.take();
				let me = self.ctx.vp.vpid.0;
				let before = self.shared.files.len();
				self.shared.files.retain(|f| Some(f.0) != id || f.1 != me);
				if self.shared.files.len() != before {
					self.commit_shared();
				}
			}
		}
		if !leaveparams {
			for p in ZFPARAMS {
				self.unsetparam(p)?;
			}
			// ZFTP_PWD is gone: up to zftp_chpwd to notice.
			self.hook("zftp_chpwd")?;
		}
		self.st.closing = false;
		self.st.drrrring = false;
		Ok(())
	}

	// ---- sessions
	// ---------------------------------------------------------------

	/// zsh `newsession`: switch to session `nm`, creating it.
	fn newsession(&mut self, nm: &[u8]) -> Z<()> {
		if let Some(i) = self.st.sessions.iter().position(|s| s.name == nm) {
			self.st.cur = i;
		} else {
			self.st.sessions.push(Session::new(nm));
			self.st.cur = self.st.sessions.len() - 1;
		}
		let name = self.sess().name.clone();
		self.setsparam("ZFTP_SESSION", &name)
	}

	/// zsh `savesession`.
	fn savesession(&mut self) -> Z<()> {
		for (i, p) in ZFPARAMS.iter().enumerate() {
			let v = self.getsparam(p)?;
			self.sess().params[i] = v;
		}
		Ok(())
	}

	/// zsh `switchsession`.
	fn switchsession(&mut self, nm: &[u8]) -> Z<()> {
		self.newsession(nm)?;
		for (i, p) in ZFPARAMS.iter().enumerate() {
			match self.sess().params[i].take() {
				// Restored as a scalar, as zsh does.
				Some(v) => self.setsparam(p, &v)?,
				None => self.unsetparam(p)?,
			}
		}
		Ok(())
	}

	// ---- subcommands
	// -------------------------------------------------------------

	/// zsh `bin_zftp`.
	fn bin_zftp(&mut self, args: &[BString]) -> Z<i32> {
		let cnam = &args[0];
		let args = &args[1..];
		let Some(&(cname, fun, min, max, flags)) =
			CMDS.iter().find(|c| c.0.as_bytes() == cnam.as_slice())
		else {
			self.warn("zftp", format!("no such subcommand: {}", cnam.to_str_lossy()))?;
			return Ok(1);
		};
		let n = args.len();
		if n < min || (max != -1 && n > max as usize) {
			self.warn("zftp", format!("wrong no. of arguments for {cname}"))?;
			return Ok(1);
		}
		let fullname = format!("zftp {cname}");
		if self.st.statfd.is_some() && flags & SESS == 0 {
			// The status in case a subshell changed it.
			let old = self.status();
			if let Some(words) = self.statfile().cloned() {
				for (s, w) in self.st.sessions.iter_mut().zip(words) {
					s.status = w;
				}
			}
			if self.control_fd().is_some() && self.status() & ST_CLOS != 0 {
				// Closed in a subshell without us knowing.
				self.st.cfinish = 2;
				self.zfclose(false)?;
			} else {
				let new = self.status();
				if old & ST_TMSK != new & ST_TMSK {
					self.setsparam("ZFTP_TYPE", if new & ST_TMSK == 0 { b"A" } else { b"I" })?;
				}
				if old & ST_MMSK != new & ST_MMSK {
					self.setsparam("ZFTP_MODE", if new & ST_MMSK == ST_BLOC { b"B" } else { b"S" })?;
				}
			}
		}
		// Anything waiting on the connection (a 421 after a timeout).
		let ret = if self.control_fd().is_some() && flags & (TEST | SESS) == 0 {
			self.test()?
		} else {
			0
		};
		if flags & CONN != 0 && self.control_fd().is_none() {
			if ret != 2 {
				self.warn(&fullname, "not connected.")?;
			}
			return Ok(1);
		}
		if let Some(prefs) = self.getsparam("ZFTP_PREFS")? {
			self.st.prefs = 0;
			for &c in prefs.iter() {
				match c.to_ascii_uppercase() {
					b'S' => self.st.prefs |= PF_SNDP,
					// Never passive once sendport was asked for.
					b'P' if self.st.prefs & PF_SNDP == 0 => self.st.prefs |= PF_PASV,
					b'P' => {},
					b'D' => self.st.prefs |= PF_DUMB,
					_ => {
						let msg = format!("preference {} not recognized", char::from(c));
						self.warn("zftp", msg)?;
					},
				}
			}
		}
		let ret = match fun {
			Fun::Open => self.open(&fullname, args)?,
			Fun::Params => self.params(args)?,
			Fun::Login => self.login(&fullname, args)?,
			Fun::Test => self.test()?,
			Fun::Cd => self.cd(args, flags)?,
			Fun::Dir => self.dir(&fullname, args, flags)?,
			Fun::Type => self.type_(&fullname, args, flags)?,
			Fun::Mode => self.mode(&fullname, args)?,
			Fun::Local => self.local(args, flags)?,
			Fun::GetPut => self.getput(&fullname, args, flags)?,
			Fun::Delete => self.delete(args)?,
			Fun::Mkdir => self.mkdir(args, flags)?,
			Fun::Rename => self.rename(args)?,
			Fun::Quote => self.quote(args, flags)?,
			Fun::Close => {
				self.zfclose(false)?;
				0
			},
			Fun::Session => self.session(args)?,
			Fun::RmSession => self.rmsession(args)?,
		};
		if self.st.drrrring {
			// A timeout: close the connection without a QUIT.
			self.st.cfinish = 2;
			self.zfclose(false)?;
		}
		if self.st.statfd.is_some() {
			self.write_status();
		}
		Ok(ret)
	}

	/// zsh `zftp_open`.
	fn open(&mut self, name: &str, args: &[BString]) -> Z<i32> {
		let args: Vec<BString> = if args.is_empty() {
			if let Some(u) = self.sess().userparams.clone() {
				u
			} else {
				self.warn(name, "no host specified")?;
				return Ok(1);
			}
		} else {
			args.to_vec()
		};
		// Close any connection first.
		if self.control_fd().is_some() {
			self.zfclose(false)?;
		}
		let arg0 = args.first().cloned().unwrap_or_default();
		let (hostnam, suffix): (BString, BString) = if arg0.first() == Some(&b'[') {
			// An IPv6 address in brackets (RFC 2732).
			let rest = &arg0[1..];
			match rest.find_byte(b']') {
				Some(e) if matches!(rest.get(e + 1), None | Some(b':')) => {
					(BString::from(&rest[..e]), BString::from(&rest[e + 1..]))
				},
				_ => {
					self.warn(name, format!("Invalid host format: {}", rest.to_str_lossy()))?;
					return Ok(1);
				},
			}
		} else {
			match arg0.find_byte(b':') {
				Some(c) => (BString::from(&arg0[..c]), BString::from(&arg0[c..])),
				None => (arg0.clone(), BString::default()),
			}
		};
		let mut portnam = BString::from("ftp");
		let mut port: Option<u16> = None;
		if let Some(c) = suffix.find_byte(b':') {
			let p = &suffix[c + 1..];
			// zsh: a name unless `zstrtol` takes all of it; the number as an
			// `unsigned short`.
			let (n, end) = zstrtol_end(p);
			if end == p.len() {
				port = Some(n as u16);
			} else {
				portnam = p.into();
			}
		}
		if !matches!(self.ask(ZftpOp::Sockets)?, ZftpAns::Flag(true)) {
			// This host's shells may not open sockets: fail loudly.
			let d = Diag::Unsupported { what: "`zftp open' (no sockets on this host)".into() };
			let bytes = self
				.ctx
				.k
				.render_quiet(self.ctx.cx, self.ctx.vp, self.ctx.line, &d);
			self.out(2, bytes)?;
			return Ok(1);
		}
		let service = match port {
			Some(p) => matches!(self.ask(ZftpOp::ServicePort(p))?, ZftpAns::Flag(true)).then_some(p),
			None => match self.ask(ZftpOp::Service(portnam.clone()))? {
				ZftpAns::Port(p) => p,
				_ => None,
			},
		};
		let Some(tcp_port) = service else {
			self.warn(name, format!("Can't find port for service `{}'", portnam.to_str_lossy()))?;
			return Ok(1);
		};
		// No talking to the server yet.
		self.st.cfinish = 2;
		// One alarm for the lookup and the connect.
		let tmout = self.tmout()?;
		let deadline = if tmout > 0 {
			match self.ask(ZftpOp::Clock)? {
				ZftpAns::Num(now) => Some(now.saturating_add(u64::from(tmout) * 1_000_000_000)),
				_ => None,
			}
		} else {
			None
		};
		let mut connected = None;
		for v6 in [true, false] {
			let addrs = match self.ask(ZftpOp::Resolve { host: hostnam.clone(), v6, deadline })? {
				ZftpAns::Addrs(Ok(a)) => a,
				ZftpAns::Addrs(Err(true)) => return self.open_timeout(name, false),
				_ => {
					if v6 {
						continue;
					}
					self.warn(name, format!("host not found: {}", hostnam.to_str_lossy()))?;
					return Ok(1);
				},
			};
			self.setsparam("ZFTP_HOST", &hostnam)?;
			self.setiparam("ZFTP_PORT", i64::from(tcp_port))?;
			// The socket counts as open from here.
			self.st.nopen += 1;
			let mut err = None;
			for addr in &addrs {
				let sa = SocketAddr::new(*addr, tcp_port);
				match self.ask(ZftpOp::Connect { addr: sa, deadline })? {
					ZftpAns::Sock(Ok(info)) => {
						connected = Some((info, *addr));
						break;
					},
					ZftpAns::Sock(Err(f)) if f.timed_out => {
						self.st.nopen -= 1;
						return self.open_timeout(name, true);
					},
					ZftpAns::Sock(Err(f)) => err = Some(f),
					_ => {},
				}
			}
			if connected.is_some() {
				break;
			}
			// zsh `zfclose(0)` of the unconnected socket.
			self.st.nopen -= 1;
			self.unconnected_close()?;
			if v6 {
				continue;
			}
			let text = err.map_or_else(|| "connection refused".to_owned(), |f| f.text());
			self.warn(name, format!("connect failed: {text}"))?;
			return Ok(1);
		}
		let Some((info, addr)) = connected else {
			return Ok(1);
		};
		let ctl = Ctl { fd: info.fd, sock: info.local, peer: info.peer };
		self.tcp_add(&ctl)?;
		self.sess().control = Some(ctl);
		self.setsparam("ZFTP_IP", addr.to_string().as_bytes())?;
		self.st.cfinish = 0;
		if info.local.is_none() {
			self.warn(name, "getsockname failed: socket is not connected")?;
			self.zfclose(false)?;
			return Ok(1);
		}
		// What the server has to say about that.
		if self.getmsg()? >= 4 {
			self.zfclose(false)?;
			return Ok(1);
		}
		if self.control_fd().is_none() {
			return Ok(1);
		}
		self.sess().has_size = CP_UNKN;
		self.sess().has_mdtm = CP_UNKN;
		self.sess().dfd = None;
		self.set_status(0);
		if self.st.statfd.is_none() {
			let id = self.shared.next;
			self.shared.next += 1;
			self.shared.files.push((id, self.ctx.vp.vpid.0, Vec::new()));
			self.st.statfd = Some(id);
			self.commit_shared();
		}
		self.setsparam("ZFTP_MODE", b"S")?;
		if args.len() > 1 {
			return self.login(name, &args[1..]);
		}
		Ok(i32::from(self.control_fd().is_none()))
	}

	/// zsh's alarm going off in `zftp_open`; `socket`: the socket existed
	/// (then `zfclose` has something to close).
	fn open_timeout(&mut self, name: &str, socket: bool) -> Z<i32> {
		match self.getsparam("ZFTP_HOST")? {
			Some(h) if !h.is_empty() => {
				self.warn(name, format!("timeout connecting to {}", h.to_str_lossy()))?;
			},
			_ => self.warn(name, "timeout on host name lookup")?,
		}
		if socket {
			self.unconnected_close()?;
		}
		Ok(1)
	}

	/// zsh `zfclose(0)` of a session whose socket never connected (no fd,
	/// no QUIT): the status bookkeeping, the parameters, `zftp_chpwd`.
	fn unconnected_close(&mut self) -> Z<()> {
		if self.st.statfd.is_some() {
			let s = self.status() | ST_CLOS;
			self.set_status(s);
			if self.st.nopen == 0 {
				self.write_status();
				self.st.statfd = None;
			}
		}
		for p in ZFPARAMS {
			self.unsetparam(p)?;
		}
		self.hook("zftp_chpwd")?;
		self.st.closing = false;
		self.st.drrrring = false;
		Ok(())
	}

	/// zsh `zfgetinfo`: a line from stdin, prompted for on a terminal.
	fn getinfo(&mut self, prompt: &[u8], noecho: bool) -> Z<BString> {
		let tty = matches!(self.ask(ZftpOp::Tty(0))?, ZftpAns::Flag(true));
		if tty {
			if noecho {
				self.ask(ZftpOp::Echo(false))?;
			}
			self.out(2, prompt)?;
		}
		let seq = self.seq;
		self.seq += 1;
		let probe = Probe::Input {
			fd:         0,
			delim:      Some(b'\n'),
			lines:      1,
			nchars:     Some(255),
			part:       0x8000_0000 | seq,
			timeout_ns: None,
		};
		let mut line = match self.ctx.probe(probe)? {
			ProbeResult::Input { data, .. } => data,
			_ => BString::default(),
		};
		if line.last() == Some(&b'\n') {
			line.pop();
		}
		if tty && noecho {
			// The newline was not echoed.
			self.out(1, "\n")?;
			self.ask(ZftpOp::Echo(true))?;
		}
		Ok(line)
	}

	/// zsh `zftp_params`.
	fn params(&mut self, args: &[BString]) -> Z<i32> {
		if args.is_empty() {
			let Some(u) = self.sess().userparams.clone() else {
				return Ok(1);
			};
			let mut out = BString::default();
			for (i, a) in u.iter().enumerate() {
				if i == 2 {
					out.extend_from_slice(&vec![b'*'; a.len()]);
				} else {
					out.extend_from_slice(a);
				}
				out.push(b'\n');
			}
			self.out(1, out)?;
			return Ok(0);
		}
		if args[0] == "-" {
			self.sess().userparams = None;
			return Ok(0);
		}
		const PROMPTS: [&str; 4] = ["Host: ", "User: ", "Password: ", "Account: "];
		let mut new = Vec::with_capacity(args.len());
		for (i, a) in args.iter().enumerate() {
			let s = if a.first() == Some(&b'?') {
				let prompt = if a.len() > 1 {
					BString::from(&a[1..])
				} else {
					BString::from(PROMPTS[i])
				};
				self.getinfo(&prompt, i == 2)?
			} else if a.first() == Some(&b'\\') {
				BString::from(&a[1..])
			} else {
				a.clone()
			};
			new.push(s);
		}
		self.sess().userparams = Some(new);
		Ok(0)
	}

	/// zsh `zftp_login`.
	fn login(&mut self, name: &str, args: &[BString]) -> Z<i32> {
		if self.status() & ST_LOGI != 0 && self.sendcmd(b"REIN\r\n")? >= 4 {
			return Ok(1);
		}
		let s = self.status() & !ST_LOGI;
		self.set_status(s);
		let mut args = args.iter();
		let user = match args.next() {
			Some(u) => u.clone(),
			None => self.getinfo(b"User: ", false)?,
		};
		let mut acct = None;
		let mut stopit = 0;
		let mut cmd = BString::from("USER ");
		cmd.extend_from_slice(&user);
		cmd.extend_from_slice(b"\r\n");
		if self.sendcmd(&cmd)? == 6 {
			stopit = 2;
		}
		while stopit == 0 {
			match self.st.lastcode {
				230 | 202 => stopit = 1,
				331 => {
					let pw = match args.next() {
						Some(p) => p.clone(),
						None => self.getinfo(b"Password: ", true)?,
					};
					let mut cmd = BString::from("PASS ");
					cmd.extend_from_slice(&pw);
					cmd.extend_from_slice(b"\r\n");
					if self.sendcmd(&cmd)? == 6 {
						stopit = 2;
					}
				},
				332 | 532 => {
					let a = match args.next() {
						Some(a) => a.clone(),
						None => self.getinfo(b"Account: ", false)?,
					};
					let mut cmd = BString::from("ACCT ");
					cmd.extend_from_slice(&a);
					cmd.extend_from_slice(b"\r\n");
					acct = Some(a);
					if self.sendcmd(&cmd)? == 6 {
						stopit = 2;
					}
				},
				_ => stopit = 2,
			}
		}
		if self.control_fd().is_none() {
			return Ok(1);
		}
		if stopit == 2 || (self.st.lastcode != 230 && self.st.lastcode != 202) {
			self.warn(name, "login failed")?;
			return Ok(1);
		}
		let left = args.len();
		if left > 0 {
			self.warn(name, format!("warning: {left} command arguments not used\n"))?;
		}
		let s = self.status() | ST_LOGI;
		self.set_status(s);
		self.setsparam("ZFTP_USER", &user)?;
		if let Some(a) = acct {
			self.setsparam("ZFTP_ACCOUNT", &a)?;
		}
		// What system this is: some servers only say once logged in.
		if self.st.prefs & PF_DUMB == 0 && self.status() & ST_SYST == 0 {
			if self.sendcmd(b"SYST\r\n")? == 2 {
				let systype = self.st.lastmsg.clone();
				if systype.starts_with(b"UNIX Type: L8") {
					// Binary for transfers.
					let s = self.status() | ST_IMAG;
					self.set_status(s);
				}
				self.setsparam("ZFTP_SYSTEM", &systype)?;
			}
			let s = self.status() | ST_SYST;
			self.set_status(s);
		}
		let t: &[u8] = if self.status() & ST_TMSK == 0 {
			b"A"
		} else {
			b"I"
		};
		self.setsparam("ZFTP_TYPE", t)?;
		self.getcwd()
	}

	/// zsh `zftp_test`: read anything the server sent meanwhile.
	fn test(&mut self) -> Z<i32> {
		let Some(fd) = self.control_fd() else {
			return Ok(1);
		};
		match self.ask(ZftpOp::Poll { fd })? {
			ZftpAns::Polled(Err(_)) => self.zfclose(false)?,
			ZftpAns::Polled(Ok(true)) => {
				// Handles a 421.
				self.getmsg()?;
			},
			_ => {},
		}
		Ok(if self.control_fd().is_some() { 0 } else { 2 })
	}

	/// zsh `zftp_dir` (`dir`, `ls`).
	fn dir(&mut self, name: &str, args: &[BString], flags: u32) -> Z<i32> {
		// RFC 959: ASCII for listings.
		self.settype(0)?;
		let cmd = argstring(if flags & NLST != 0 { b"NLST" } else { b"LIST" }, args);
		if self.getdata(name, None, &cmd, false)? {
			return Ok(1);
		}
		Ok(i32::from(self.senddata(name, true, false, 0)?))
	}

	/// zsh `zftp_cd` (`cd`, `cdup`).
	fn cd(&mut self, args: &[BString], flags: u32) -> Z<i32> {
		let ret = if flags & CDUP != 0 || args[0] == ".." || args[0] == "../" {
			self.sendcmd(b"CDUP\r\n")?
		} else {
			let mut cmd = BString::from("CWD ");
			cmd.extend_from_slice(&args[0]);
			cmd.extend_from_slice(b"\r\n");
			self.sendcmd(&cmd)?
		};
		if ret > 2 {
			return Ok(1);
		}
		Ok(i32::from(self.getcwd()? != 0))
	}

	/// zsh `zftp_type` (`type`, `ascii`, `binary`).
	fn type_(&mut self, name: &str, args: &[BString], flags: u32) -> Z<i32> {
		let nt = if flags & (TBIN | TASC) != 0 {
			if flags & TBIN != 0 { b'I' } else { b'A' }
		} else if let Some(s) = args.first() {
			let nt = s.first().copied().unwrap_or(0).to_ascii_uppercase();
			if s.len() > 1 || !matches!(nt, b'A' | b'B' | b'I') {
				self.warn(name, format!("transfer type {} not recognised", s.to_str_lossy()))?;
				return Ok(1);
			}
			if nt == b'B' { b'I' } else { nt }
		} else {
			let t = if self.status() & ST_TMSK == 0 {
				"A\n"
			} else {
				"I\n"
			};
			self.out(1, t)?;
			return Ok(0);
		};
		let s = (self.status() & !ST_TMSK) | if nt == b'I' { ST_IMAG } else { 0 };
		self.set_status(s);
		self.setsparam("ZFTP_TYPE", &[nt])?;
		Ok(0)
	}

	/// zsh `zftp_mode`.
	fn mode(&mut self, name: &str, args: &[BString]) -> Z<i32> {
		let Some(s) = args.first() else {
			let m = if self.status() & ST_MMSK == 0 {
				"S\n"
			} else {
				"B\n"
			};
			self.out(1, m)?;
			return Ok(0);
		};
		// zsh upper-cases the argument in place.
		let mut s = s.clone();
		if let Some(c) = s.first_mut() {
			*c = c.to_ascii_uppercase();
		}
		let nt = s.first().copied().unwrap_or(0);
		if s.len() > 1 || !matches!(nt, b'S' | b'B') {
			self.warn(name, format!("transfer mode {} not recognised", s.to_str_lossy()))?;
			return Ok(1);
		}
		let cmd = [b'M', b'O', b'D', b'E', b' ', nt, b'\r', b'\n'];
		if self.sendcmd(&cmd)? > 2 {
			return Ok(1);
		}
		// zsh keeps only the mode bits here (`&= ZFST_MMSK`), then sets them.
		let st = (self.status() & ST_MMSK) | if nt == b'S' { 0 } else { ST_BLOC };
		self.set_status(st);
		self.setsparam("ZFTP_MODE", &s)?;
		Ok(0)
	}

	/// zsh `zftp_local` (`local`, `remote`).
	fn local(&mut self, args: &[BString], flags: u32) -> Z<i32> {
		let more = args.len() > 1;
		let dofd = args.is_empty();
		let mut ret = 0;
		let mut i = 0;
		while i < args.len() || dofd {
			let arg = args.get(i).cloned().unwrap_or_default();
			let (newret, sz, mt) = self.stats(&arg, flags & HERE == 0, true, dofd)?;
			if newret == 2 {
				return Ok(2);
			}
			if newret != 0 {
				ret = 1;
				if dofd {
					break;
				}
				i += 1;
				continue;
			}
			let mut out = BString::default();
			if more {
				out.extend_from_slice(&arg);
				out.push(b' ');
			}
			out.extend_from_slice(sz.to_string().as_bytes());
			out.push(b' ');
			match mt {
				Some(m) => out.extend_from_slice(&m),
				None => out.extend_from_slice(b"(null)"),
			}
			out.push(b'\n');
			self.out(1, out)?;
			if dofd {
				break;
			}
			i += 1;
		}
		Ok(ret)
	}

	/// zsh `zftp_getput` (`get`, `getat`, `put`, `putat`, `append`,
	/// `appendat`).
	fn getput(&mut self, name: &str, args: &[BString], flags: u32) -> Z<i32> {
		let recv = flags & RECV != 0;
		let cmd: &[u8] = if recv {
			b"RETR "
		} else if flags & APPE != 0 {
			b"APPE "
		} else {
			b"STOR "
		};
		let progress = true;
		let mut getsize = false;
		let mut ret = 0;
		let ty = self.status() & ST_TMSK;
		self.settype(ty)?;
		let mut i = 0;
		while i < args.len() {
			let arg = args[i].clone();
			let mut rest = None;
			let mut startat = 0;
			if progress && self.func("zftp_progress")? {
				// SIZE for the size of a remote file, unless the RETR reply
				// says it (then the first progress call waits for that).
				let mut sz = -1;
				let st = self.status();
				if (self.st.prefs & PF_DUMB == 0 && st & (ST_NOSZ | ST_TRSZ) != ST_TRSZ) || !recv {
					sz = self.stats(&arg, recv, false, !recv)?.1;
					if recv && sz == -1 {
						getsize = true;
					}
				} else {
					getsize = true;
				}
				self.starttrans(&arg, recv, sz)?;
			}
			if flags & REST != 0 {
				let at = args[i + 1].clone();
				startat = zstrtol(&at);
				let mut r = BString::from("REST ");
				r.extend_from_slice(&at);
				r.extend_from_slice(b"\r\n");
				rest = Some(r);
			}
			let mut ln = BString::from(cmd);
			ln.extend_from_slice(&arg);
			ln.extend_from_slice(b"\r\n");
			if self.getdata(name, rest.as_ref().map(|r| &r[..]), &ln, getsize)? {
				ret = 2;
			} else if self.senddata(name, recv, progress, startat)? {
				ret = 1;
			}
			if progress && ret != 2 && self.func("zftp_progress")? {
				// The end: ZFTP_TRANSFER is GF or PF.
				self.setsparam("ZFTP_TRANSFER", if recv { b"GF" } else { b"PF" })?;
				self.hook("zftp_progress")?;
			}
			if rest.is_some() {
				i += 1;
			}
			i += 1;
		}
		self.endtrans()?;
		Ok(i32::from(ret != 0))
	}

	/// zsh `zftp_delete`.
	fn delete(&mut self, args: &[BString]) -> Z<i32> {
		let mut ret = 0;
		for a in args {
			let mut cmd = BString::from("DELE ");
			cmd.extend_from_slice(a);
			cmd.extend_from_slice(b"\r\n");
			if self.sendcmd(&cmd)? > 2 {
				ret = 1;
			}
		}
		Ok(ret)
	}

	/// zsh `zftp_mkdir` (`mkdir`, `rmdir`).
	fn mkdir(&mut self, args: &[BString], flags: u32) -> Z<i32> {
		let mut cmd = BString::from(if flags & DELE != 0 { "RMD " } else { "MKD " });
		cmd.extend_from_slice(&args[0]);
		cmd.extend_from_slice(b"\r\n");
		Ok(i32::from(self.sendcmd(&cmd)? > 2))
	}

	/// zsh `zftp_rename`.
	fn rename(&mut self, args: &[BString]) -> Z<i32> {
		let mut cmd = BString::from("RNFR ");
		cmd.extend_from_slice(&args[0]);
		cmd.extend_from_slice(b"\r\n");
		if self.sendcmd(&cmd)? == 3 {
			let mut cmd = BString::from("RNTO ");
			cmd.extend_from_slice(&args[1]);
			cmd.extend_from_slice(b"\r\n");
			if self.sendcmd(&cmd)? == 2 {
				return Ok(0);
			}
		}
		Ok(1)
	}

	/// zsh `zftp_quote` (`quote`, `site`).
	fn quote(&mut self, args: &[BString], flags: u32) -> Z<i32> {
		let cmd = if flags & SITE != 0 {
			argstring(b"SITE", args)
		} else {
			argstring(&args[0], &args[1..])
		};
		Ok(i32::from(self.sendcmd(&cmd)? > 2))
	}

	/// zsh `zftp_session`.
	fn session(&mut self, args: &[BString]) -> Z<i32> {
		let Some(nm) = args.first() else {
			let mut out = BString::default();
			for s in &self.st.sessions {
				out.extend_from_slice(&s.name);
				out.push(b'\n');
			}
			self.out(1, out)?;
			return Ok(0);
		};
		// Already there: no-op.
		if *nm == self.sess().name {
			return Ok(0);
		}
		self.savesession()?;
		self.switchsession(nm)?;
		Ok(0)
	}

	/// zsh `zftp_rmsession`.
	fn rmsession(&mut self, args: &[BString]) -> Z<i32> {
		let no = match args.first() {
			None => self.st.cur,
			Some(nm) => match self.st.sessions.iter().position(|s| s.name == *nm) {
				Some(i) => i,
				None => return Ok(1),
			},
		};
		let mut newsess = None;
		if no == self.st.cur {
			// The current session: closed first.
			self.closedata()?;
			self.zfclose(false)?;
			if self.st.sessions.len() > 1 {
				let first = usize::from(no == 0);
				newsess = Some(self.st.sessions[first].name.clone());
			}
		} else {
			// Another session: closed without touching the parameters.
			let old = self.st.cur;
			self.st.cur = no;
			self.closedata()?;
			self.zfclose(true)?;
			self.st.cur = old;
		}
		self.st.sessions.remove(no);
		if self.st.cur > no {
			self.st.cur -= 1;
		} else if self.st.cur == no {
			self.st.cur = 0;
		}
		if self.st.sessions.is_empty() {
			// The last one: start again from scratch.
			self.newsession(b"default")?;
		} else if let Some(n) = newsess {
			self.switchsession(&n)?;
		}
		Ok(0)
	}

	/// zsh `zftp_cleanup`: close every session (module unload, shell exit).
	fn cleanup(&mut self) -> Z<()> {
		let cur = self.st.cur;
		for i in 0..self.st.sessions.len() {
			self.st.cur = i;
			self.closedata()?;
			self.zfclose(i != cur)?;
		}
		self.st.cur = cur.min(self.st.sessions.len().saturating_sub(1));
		self.unsetparam("ZFTP_SESSION")
	}
}

/// zsh `zfargstring`: `cmd args…\r\n`.
fn argstring(cmd: &[u8], args: &[BString]) -> BString {
	let mut line = BString::from(cmd);
	for a in args {
		line.push(b' ');
		line.extend_from_slice(a);
	}
	line.extend_from_slice(b"\r\n");
	line
}

/// The data address of a PASV reply: six numbers from its first digit,
/// `h1,h2,h3,h4,p1,p2` (zsh's `sscanf("%d,%d,%d,%d,%d,%d")`).
fn pasv_addr(msg: &[u8]) -> Option<SocketAddr> {
	let start = msg.iter().position(u8::is_ascii_digit)?;
	let mut rest = &msg[start..];
	let mut nums = [0u8; 6];
	for (i, slot) in nums.iter_mut().enumerate() {
		if i > 0 {
			rest = rest.strip_prefix(b",")?;
		}
		let (n, r) = scan_int(rest)?;
		*slot = n as u8;
		rest = r;
	}
	let ip = IpAddr::from([nums[0], nums[1], nums[2], nums[3]]);
	Some(SocketAddr::new(ip, u16::from_be_bytes([nums[4], nums[5]])))
}

/// The port of an EPSV reply (RFC 2428): `(|||port|)` with any delimiter.
fn epsv_port(msg: &[u8]) -> Option<u16> {
	let p = msg.find_byte(b'(')?;
	let s = &msg[p..];
	let delim = *s.get(1)?;
	if !(33..=126).contains(&delim) || s.get(2) != Some(&delim) || s.get(3) != Some(&delim) {
		return None;
	}
	let body = &s[4..];
	let end = body.find_byte(delim)?;
	if body.get(end + 1) != Some(&b')') {
		return None;
	}
	let mut digits = &body[..end];
	while digits.first() == Some(&b'0') {
		digits = &digits[1..];
	}
	if digits.is_empty() || digits.len() > 5 || !digits.iter().all(u8::is_ascii_digit) {
		return None;
	}
	let n: u32 = digits.to_str().ok()?.parse().ok()?;
	u16::try_from(n).ok()
}

/// zsh `bin_zftp` (`args[0]` is the subcommand).
pub fn zftp(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let mut z = match Zf::start(ctx) {
		Ok(z) => z,
		Err(Stop::Need(n)) => return Err(n),
		Err(Stop::Hook) => return done(1),
	};
	match z.bin_zftp(args) {
		Ok(status) => {
			z.commit();
			done(status)
		},
		Err(Stop::Hook) => Ok(Outcome { status: 0, control: Control::Resume }),
		Err(Stop::Need(n)) => Err(n),
	}
}

/// zsh/zftp `boot_`: the default parameters and the session `default`.
pub fn boot(ctx: &mut Ctx<'_, '_>) -> Result<(), Need> {
	let mut z = match Zf::start(ctx) {
		Ok(z) => z,
		Err(Stop::Need(n)) => return Err(n),
		Err(Stop::Hook) => return Ok(()),
	};
	z.st = State::booted();
	let r = (|| -> Z<()> {
		z.setparam("ZFTP_VERBOSE", b"450", false, false, true)?;
		z.setparam("ZFTP_TMOUT", b"60", true, false, true)?;
		z.setparam("ZFTP_PREFS", b"PS", false, false, true)?;
		z.newsession(b"default")
	})();
	match r {
		Ok(()) => {
			z.commit();
			Ok(())
		},
		Err(Stop::Need(n)) => Err(n),
		Err(Stop::Hook) => Ok(()),
	}
}

/// zsh/zftp `cleanup_` (`zmodload -u`): close every session and forget
/// them. `zftp_chpwd` cannot run here: a call it would get is reported
/// as unsupported.
pub fn finish(ctx: &mut Ctx<'_, '_>) -> Result<(), Need> {
	let mut z = match Zf::start(ctx) {
		Ok(z) => z,
		Err(Stop::Need(n)) => return Err(n),
		Err(Stop::Hook) => return Ok(()),
	};
	z.no_hooks = true;
	match z.cleanup() {
		Ok(()) | Err(Stop::Hook) => {
			ctx_forget(z.ctx);
			Ok(())
		},
		Err(Stop::Need(n)) => Err(n),
	}
}

/// zsh/zftp's exit hook (`zftpexithook` → `zftp_cleanup`) at shell exit:
/// every session closed (the current one sends `QUIT`, unsets its
/// parameters and calls `zftp_chpwd`), then the state forgotten. A hook
/// call pushes its frame and returns [`Control::Resume`]; the caller runs
/// this again when the frame returns, with the answers so far.
pub fn exit_hook(ctx: &mut Ctx<'_, '_>) -> R {
	let mut z = match Zf::start(ctx) {
		Ok(z) => z,
		Err(Stop::Need(n)) => return Err(n),
		Err(Stop::Hook) => return done(0),
	};
	match z.cleanup() {
		Ok(()) => {
			ctx_forget(z.ctx);
			done(0)
		},
		Err(Stop::Hook) => Ok(Outcome { status: 0, control: Control::Resume }),
		Err(Stop::Need(n)) => Err(n),
	}
}

/// Drop the module state record (the module is gone).
fn ctx_forget(ctx: &mut Ctx<'_, '_>) {
	ctx.store_record(KeyBuf::Misc(MiscKey::Zftp), None);
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn pasv_replies_parse_like_sscanf() {
		let a = pasv_addr(b"Entering Passive Mode (127,0,0,1,4,1)").unwrap();
		assert_eq!(a, "127.0.0.1:1025".parse().unwrap());
		assert!(pasv_addr(b"Entering Passive Mode (127,0,0,1)").is_none());
		assert_eq!(pasv_addr(b"=10,1,2,3,256,7").unwrap(), "10.1.2.3:7".parse().unwrap());
	}

	#[test]
	fn epsv_replies_follow_rfc_2428() {
		assert_eq!(epsv_port(b"Entering Extended Passive Mode (|||6446|)"), Some(6446));
		assert_eq!(epsv_port(b"(!!!0021!)"), Some(21));
		assert_eq!(epsv_port(b"(|||70000|)"), None);
		assert_eq!(epsv_port(b"(||6446|)"), None);
	}

	#[test]
	fn mdtm_is_utc_ftp_time() {
		assert_eq!(mdtm(0), "19700101000000");
		assert_eq!(mdtm(1_577_934_245), "20200102030405");
	}

	#[test]
	fn zstrtol_takes_a_leading_number() {
		assert_eq!(zstrtol(b" 1234 bytes"), 1234);
		assert_eq!(zstrtol(b"-5x"), -5);
		assert_eq!(zstrtol(b"x"), 0);
	}
}
