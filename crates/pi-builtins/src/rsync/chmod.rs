//! `--chmod` rules: the comma-separated symbolic/octal grammar of rsync's
//! `--chmod` option and its application to file-list modes.
//!
//! Grammar of one clause (clauses are separated by `,`; several `--chmod`
//! options accumulate in order):
//!
//! - an optional run of `D` (directories only) / `F` (non-directories only),
//! - then either an octal number of up to `07777` (`[DF]*[0-7]+`, replacing all
//!   permission bits), or `[ugoa]*` followed by exactly one of `+`, `-`, `=`
//!   and then either `[rwxXst]*` or a single copy source `u`, `g`, or `o`.
//!
//! A clause that names no class (`+x`, `=r`) acts on all classes but never
//! grants or copies a bit the umask masks. `X` grants execute only to
//! directories and to files that were executable before any clause ran.

use crate::rsync::consts::{CHMOD_BITS, S_ISGID, S_ISUID, S_ISVTX, mode_is_dir};

/// Class masks: one bit per permission triplet, so `classes * rwx` spreads an
/// `rwx` value (4/2/1) over the selected triplets.
const USER: u32 = 0o100;
const GROUP: u32 = 0o010;
const OTHER: u32 = 0o001;
const ALL: u32 = USER | GROUP | OTHER;

/// Which entries a clause applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scope {
	Any,
	Dirs,
	Files,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
	Add,
	Remove,
	Assign,
}

/// A symbolic clause, fully resolved at parse time (the umask included).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Symbolic {
	op: Op,
	/// Selected triplets (`USER | GROUP | OTHER` subset; all when none named).
	classes: u32,
	/// Special bits that `=` clears when the clause sets any: setuid for `u`,
	/// setgid for `g`, both for `a`.
	class_specials: u32,
	/// `rwx` spread over `classes`, already filtered by `allowed`.
	perms: u32,
	/// `X` was present: execute is granted only to dirs and executable files.
	cond_exec: bool,
	/// Setuid/setgid/sticky bits named via `s`/`t`.
	specials: u32,
	/// Copy source triplet (`USER`, `GROUP`, `OTHER`), or 0.
	copy_from: u32,
	/// Result bits a clause may grant or copy: everything when a class was
	/// named, else what the umask leaves.
	allowed: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
	/// Octal form: the permission bits become exactly this value.
	Set(u32),
	Symbolic(Symbolic),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Clause {
	scope: Scope,
	action: Action,
}

/// Parsed --chmod rules (D/F prefixes, ugoa, +-=, rwxXst, octal).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ChmodRules {
	clauses: Vec<Clause>,
}

impl ChmodRules {
	/// Parses one `--chmod` argument and appends its clauses to `prior` (multiple
	/// `--chmod` options accumulate). Who-less clauses honor the host process umask
	/// (`0o022` on Windows). The error is upstream's message, without a trailing newline.
	pub(crate) fn parse(spec: &str, prior: Option<Self>) -> Result<Self, String> {
		#[cfg(unix)]
		let umask = crate::host::process_umask();
		#[cfg(not(unix))]
		let umask = 0o022;
		Self::parse_with_umask(spec, prior, umask)
	}

	/// [`ChmodRules::parse`] with an explicit umask (the shell's, when it has one).
	pub(crate) fn parse_with_umask(
		spec: &str,
		prior: Option<Self>,
		umask: u32,
	) -> Result<Self, String> {
		let invalid = || format!("Invalid argument passed to --chmod ({spec})");
		let mut rules = prior.unwrap_or_default();
		for part in spec.as_bytes().split(|&b| b == b',') {
			rules.clauses.push(parse_clause(part, umask).ok_or_else(invalid)?);
		}
		Ok(rules)
	}

	/// Applies every clause in order to `mode` (type bits included, which select
	/// `D`/`F` clauses and are preserved).
	pub(crate) fn apply(&self, mode: u32) -> u32 {
		let type_bits = mode & !CHMOD_BITS;
		let is_dir = mode_is_dir(mode);
		let was_exec = mode & 0o111 != 0;
		let mut perms = mode & CHMOD_BITS;
		for clause in &self.clauses {
			match clause.scope {
				Scope::Dirs if !is_dir => continue,
				Scope::Files if is_dir => continue,
				_ => {},
			}
			perms = match clause.action {
				Action::Set(value) => value,
				Action::Symbolic(sym) => apply_symbolic(&sym, perms, is_dir, was_exec),
			};
		}
		perms | type_bits
	}
}

/// One clause's effect on the permission bits `perms`.
fn apply_symbolic(sym: &Symbolic, perms: u32, is_dir: bool, was_exec: bool) -> u32 {
	// The copy source is read before this clause changes anything.
	let copied = if sym.copy_from == 0 {
		0
	} else {
		(sym.classes * triplet(perms, sym.copy_from)) & sym.allowed
	};
	let mut grant = sym.perms;
	if sym.cond_exec && !was_exec && !is_dir {
		grant &= !0o111;
	}
	match sym.op {
		Op::Add => perms | grant | sym.specials | copied,
		Op::Remove => perms & !(sym.perms | sym.specials | copied),
		Op::Assign => {
			let mut clear = sym.classes * 7;
			if sym.specials != 0 {
				clear |= sym.class_specials;
			}
			if sym.copy_from != 0 {
				clear |= dest_specials(sym.classes);
			}
			(perms & !clear) | grant | sym.specials | copied
		},
	}
}

/// The rwx value (0..=7) of the triplet selected by `class`.
const fn triplet(perms: u32, class: u32) -> u32 {
	match class {
		USER => (perms >> 6) & 7,
		GROUP => (perms >> 3) & 7,
		_ => perms & 7,
	}
}

/// Special bits "belonging" to the destination triplets of a copy (`=` clears them).
const fn dest_specials(classes: u32) -> u32 {
	let mut bits = 0;
	if classes & USER != 0 {
		bits |= S_ISUID;
	}
	if classes & GROUP != 0 {
		bits |= S_ISGID;
	}
	if classes & OTHER != 0 {
		bits |= S_ISVTX;
	}
	bits
}

/// Parses one comma-free clause; `None` when it is malformed.
fn parse_clause(text: &[u8], umask: u32) -> Option<Clause> {
	let mut scope = Scope::Any;
	let mut classes = 0u32;
	let mut class_specials = 0u32;
	let mut i = 0;
	// Prefix: D/F and the class letters, in any order.
	let op = loop {
		let &c = text.get(i)?;
		i += 1;
		match c {
			b'D' => {
				if scope == Scope::Files {
					return None;
				}
				scope = Scope::Dirs;
			},
			b'F' => {
				if scope == Scope::Dirs {
					return None;
				}
				scope = Scope::Files;
			},
			b'u' => {
				classes |= USER;
				class_specials |= S_ISUID;
			},
			b'g' => {
				classes |= GROUP;
				class_specials |= S_ISGID;
			},
			b'o' => classes |= OTHER,
			b'a' => {
				classes |= ALL;
				class_specials |= S_ISUID | S_ISGID;
			},
			b'+' => break Op::Add,
			b'-' => break Op::Remove,
			b'=' => break Op::Assign,
			b'0'..=b'7' if classes == 0 => {
				let value = parse_octal(&text[i - 1..])?;
				return Some(Clause { scope, action: Action::Set(value) });
			},
			_ => return None,
		}
	};

	let mut rwx = 0u32;
	let mut cond_exec = false;
	let mut specials = 0u32;
	let mut copy_from = 0u32;
	for &c in &text[i..] {
		let copy_class = match c {
			b'u' => Some(USER),
			b'g' => Some(GROUP),
			b'o' => Some(OTHER),
			_ => None,
		};
		if let Some(class) = copy_class {
			if rwx != 0 || specials != 0 || copy_from != 0 {
				return None;
			}
			copy_from = class;
			continue;
		}
		if copy_from != 0 {
			return None;
		}
		match c {
			b'r' => rwx |= 4,
			b'w' => rwx |= 2,
			b'x' => rwx |= 1,
			b'X' => {
				rwx |= 1;
				cond_exec = true;
			},
			b's' => {
				if class_specials == 0 {
					specials = S_ISUID;
				} else {
					specials |= class_specials;
				}
			},
			b't' => specials |= S_ISVTX,
			_ => return None,
		}
	}

	let named = classes != 0;
	let classes = if named { classes } else { ALL };
	let allowed = if named { CHMOD_BITS } else { !umask & CHMOD_BITS };
	Some(Clause {
		scope,
		action: Action::Symbolic(Symbolic {
			op,
			classes,
			class_specials,
			perms: (classes * rwx) & allowed,
			cond_exec,
			specials,
			copy_from,
			allowed,
		}),
	})
}

/// All-octal-digit tail of an octal clause, at most `07777`.
fn parse_octal(digits: &[u8]) -> Option<u32> {
	let mut value = 0u32;
	for &d in digits {
		if !(b'0'..=b'7').contains(&d) {
			return None;
		}
		value = value * 8 + u32::from(d - b'0');
		if value > CHMOD_BITS {
			return None;
		}
	}
	Some(value)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::rsync::consts::{S_IFDIR, S_IFREG};
	use crate::rsync::log::permstring;

	/// Source entries of the golden runs: `f<octal>` files, `d<octal>` dirs
	/// (macOS dropped the setgid bit of the `2750` sources, hence `0750`).
	fn source_mode(name: &str) -> u32 {
		let kind = if name.starts_with('d') { S_IFDIR } else { S_IFREG };
		let perms = match &name[1..] {
			"2750" => 0o750,
			digits => u32::from_str_radix(digits, 8).unwrap(),
		};
		kind | perms
	}

	/// Golden rows captured from rsync 3.5.1 (`rsync -d --chmod=SPEC src/`).
	fn check_rows(umask: u32, rows: &[(&str, &str)]) {
		for (spec, row) in rows {
			let rules = ChmodRules::parse_with_umask(spec, None, umask)
				.unwrap_or_else(|e| panic!("{spec}: {e}"));
			for item in row.split_whitespace() {
				let (name, want) = item.split_once('=').unwrap();
				let got = permstring(rules.apply(source_mode(name)));
				assert_eq!(&got[..], want.as_bytes(), "spec {spec:?} umask {umask:03o} on {name}");
			}
		}
	}

	#[test]
	fn golden_umask_022() {
		check_rows(0o022, &[
			("u+x", "f000=---x------ f1777=-rwxrwxrwt f2750=-rwxr-x--- f4755=-rwsr-xr-x f600=-rwx------ f644=-rwxr--r-- f755=-rwxr-xr-x d000=d--x------ d1777=drwxrwxrwt d2750=drwxr-x--- d4755=drwsr-xr-x d600=drwx------ d644=drwxr--r-- d755=drwxr-xr-x"),
			("a+X", "f000=---------- f1777=-rwxrwxrwt f2750=-rwxr-x--x f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--x--x--x d1777=drwxrwxrwt d2750=drwxr-x--x d4755=drwsr-xr-x d600=drwx--x--x d644=drwxr-xr-x d755=drwxr-xr-x"),
			("go-w", "f000=---------- f1777=-rwxr-xr-t f2750=-rwxr-x--- f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--------- d1777=drwxr-xr-t d2750=drwxr-x--- d4755=drwsr-xr-x d600=drw------- d644=drw-r--r-- d755=drwxr-xr-x"),
			("Dg+s,Fu-x", "f000=---------- f1777=-rw-rwxrwt f2750=-rw-r-x--- f4755=-rwSr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rw-r-xr-x d000=d-----S--- d1777=drwxrwsrwt d2750=drwxr-s--- d4755=drwsr-sr-x d600=drw---S--- d644=drw-r-Sr-- d755=drwxr-sr-x"),
			("D755,F644", "f000=-rw-r--r-- f1777=-rw-r--r-- f2750=-rw-r--r-- f4755=-rw-r--r-- f600=-rw-r--r-- f644=-rw-r--r-- f755=-rw-r--r-- d000=drwxr-xr-x d1777=drwxr-xr-x d2750=drwxr-xr-x d4755=drwxr-xr-x d600=drwxr-xr-x d644=drwxr-xr-x d755=drwxr-xr-x"),
			("0", "f000=---------- f1777=---------- f2750=---------- f4755=---------- f600=---------- f644=---------- f755=---------- d000=d--------- d1777=d--------- d2750=d--------- d4755=d--------- d600=d--------- d644=d--------- d755=d---------"),
			("7777", "f000=-rwsrwsrwt f1777=-rwsrwsrwt f2750=-rwsrwsrwt f4755=-rwsrwsrwt f600=-rwsrwsrwt f644=-rwsrwsrwt f755=-rwsrwsrwt d000=drwsrwsrwt d1777=drwsrwsrwt d2750=drwsrwsrwt d4755=drwsrwsrwt d600=drwsrwsrwt d644=drwsrwsrwt d755=drwsrwsrwt"),
			("u=rwx,g=rx,o=", "f000=-rwxr-x--- f1777=-rwxr-x--T f2750=-rwxr-x--- f4755=-rwsr-x--- f600=-rwxr-x--- f644=-rwxr-x--- f755=-rwxr-x--- d000=drwxr-x--- d1777=drwxr-x--T d2750=drwxr-x--- d4755=drwsr-x--- d600=drwxr-x--- d644=drwxr-x--- d755=drwxr-x---"),
			("+x", "f000=---x--x--x f1777=-rwxrwxrwt f2750=-rwxr-x--x f4755=-rwsr-xr-x f600=-rwx--x--x f644=-rwxr-xr-x f755=-rwxr-xr-x d000=d--x--x--x d1777=drwxrwxrwt d2750=drwxr-x--x d4755=drwsr-xr-x d600=drwx--x--x d644=drwxr-xr-x d755=drwxr-xr-x"),
			("-r", "f000=---------- f1777=--wx-wx-wt f2750=--wx--x--- f4755=--ws--x--x f600=--w------- f644=--w------- f755=--wx--x--x d000=d--------- d1777=d-wx-wx-wt d2750=d-wx--x--- d4755=d-ws--x--x d600=d-w------- d644=d-w------- d755=d-wx--x--x"),
			("=r", "f000=-r--r--r-- f1777=-r--r--r-T f2750=-r--r--r-- f4755=-r-Sr--r-- f600=-r--r--r-- f644=-r--r--r-- f755=-r--r--r-- d000=dr--r--r-- d1777=dr--r--r-T d2750=dr--r--r-- d4755=dr-Sr--r-- d600=dr--r--r-- d644=dr--r--r-- d755=dr--r--r--"),
			("a=", "f000=---------- f1777=---------T f2750=---------- f4755=---S------ f600=---------- f644=---------- f755=---------- d000=d--------- d1777=d--------T d2750=d--------- d4755=d--S------ d600=d--------- d644=d--------- d755=d---------"),
			("g+s", "f000=------S--- f1777=-rwxrwsrwt f2750=-rwxr-s--- f4755=-rwsr-sr-x f600=-rw---S--- f644=-rw-r-Sr-- f755=-rwxr-sr-x d000=d-----S--- d1777=drwxrwsrwt d2750=drwxr-s--- d4755=drwsr-sr-x d600=drw---S--- d644=drw-r-Sr-- d755=drwxr-sr-x"),
			("o+s", "f000=---S------ f1777=-rwsrwxrwt f2750=-rwsr-x--- f4755=-rwsr-xr-x f600=-rwS------ f644=-rwSr--r-- f755=-rwsr-xr-x d000=d--S------ d1777=drwsrwxrwt d2750=drwsr-x--- d4755=drwsr-xr-x d600=drwS------ d644=drwSr--r-- d755=drwsr-xr-x"),
			("a+s", "f000=---S--S--- f1777=-rwsrwsrwt f2750=-rwsr-s--- f4755=-rwsr-sr-x f600=-rwS--S--- f644=-rwSr-Sr-- f755=-rwsr-sr-x d000=d--S--S--- d1777=drwsrwsrwt d2750=drwsr-s--- d4755=drwsr-sr-x d600=drwS--S--- d644=drwSr-Sr-- d755=drwsr-sr-x"),
			("+s", "f000=---S------ f1777=-rwsrwxrwt f2750=-rwsr-x--- f4755=-rwsr-xr-x f600=-rwS------ f644=-rwSr--r-- f755=-rwsr-xr-x d000=d--S------ d1777=drwsrwxrwt d2750=drwsr-x--- d4755=drwsr-xr-x d600=drwS------ d644=drwSr--r-- d755=drwsr-xr-x"),
			("+t", "f000=---------T f1777=-rwxrwxrwt f2750=-rwxr-x--T f4755=-rwsr-xr-t f600=-rw------T f644=-rw-r--r-T f755=-rwxr-xr-t d000=d--------T d1777=drwxrwxrwt d2750=drwxr-x--T d4755=drwsr-xr-t d600=drw------T d644=drw-r--r-T d755=drwxr-xr-t"),
			("o=u", "f000=---------- f1777=-rwxrwxrwx f2750=-rwxr-xrwx f4755=-rwsr-xrwx f600=-rw----rw- f644=-rw-r--rw- f755=-rwxr-xrwx d000=d--------- d1777=drwxrwxrwx d2750=drwxr-xrwx d4755=drwsr-xrwx d600=drw----rw- d644=drw-r--rw- d755=drwxr-xrwx"),
			("u=g", "f000=---------- f1777=-rwxrwxrwt f2750=-r-xr-x--- f4755=-r-xr-xr-x f600=---------- f644=-r--r--r-- f755=-r-xr-xr-x d000=d--------- d1777=drwxrwxrwt d2750=dr-xr-x--- d4755=dr-xr-xr-x d600=d--------- d644=dr--r--r-- d755=dr-xr-xr-x"),
			("g-u", "f000=---------- f1777=-rwx---rwt f2750=-rwx------ f4755=-rws---r-x f600=-rw------- f644=-rw----r-- f755=-rwx---r-x d000=d--------- d1777=drwx---rwt d2750=drwx------ d4755=drws---r-x d600=drw------- d644=drw----r-- d755=drwx---r-x"),
			("o+g", "f000=---------- f1777=-rwxrwxrwt f2750=-rwxr-xr-x f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--------- d1777=drwxrwxrwt d2750=drwxr-xr-x d4755=drwsr-xr-x d600=drw------- d644=drw-r--r-- d755=drwxr-xr-x"),
			("Fa+X", "f000=---------- f1777=-rwxrwxrwt f2750=-rwxr-x--x f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--------- d1777=drwxrwxrwt d2750=drwxr-x--- d4755=drwsr-xr-x d600=drw------- d644=drw-r--r-- d755=drwxr-xr-x"),
			("ug=rX", "f000=-r--r----- f1777=-r-xr-xrwt f2750=-r-xr-x--- f4755=-r-sr-xr-x f600=-r--r----- f644=-r--r--r-- f755=-r-xr-xr-x d000=dr-xr-x--- d1777=dr-xr-xrwt d2750=dr-xr-x--- d4755=dr-sr-xr-x d600=dr-xr-x--- d644=dr-xr-xr-- d755=dr-xr-xr-x"),
			("D=rwX,F=rw", "f000=-rw-r--r-- f1777=-rw-r--r-T f2750=-rw-r--r-- f4755=-rwSr--r-- f600=-rw-r--r-- f644=-rw-r--r-- f755=-rw-r--r-- d000=drwxr-xr-x d1777=drwxr-xr-t d2750=drwxr-xr-x d4755=drwsr-xr-x d600=drwxr-xr-x d644=drwxr-xr-x d755=drwxr-xr-x"),
			("a-st", "f000=---------- f1777=-rwxrwxrwx f2750=-rwxr-x--- f4755=-rwxr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--------- d1777=drwxrwxrwx d2750=drwxr-x--- d4755=drwxr-xr-x d600=drw------- d644=drw-r--r-- d755=drwxr-xr-x"),
			("=X", "f000=---------- f1777=---x--x--t f2750=---x--x--x f4755=---s--x--x f600=---------- f644=---------- f755=---x--x--x d000=d--x--x--x d1777=d--x--x--t d2750=d--x--x--x d4755=d--s--x--x d600=d--x--x--x d644=d--x--x--x d755=d--x--x--x"),
			("u=s", "f000=---S------ f1777=---Srwxrwt f2750=---Sr-x--- f4755=---Sr-xr-x f600=---S------ f644=---Sr--r-- f755=---Sr-xr-x d000=d--S------ d1777=d--Srwxrwt d2750=d--Sr-x--- d4755=d--Sr-xr-x d600=d--S------ d644=d--Sr--r-- d755=d--Sr-xr-x"),
			("=s", "f000=---S------ f1777=---S-----T f2750=---S------ f4755=---S------ f600=---S------ f644=---S------ f755=---S------ d000=d--S------ d1777=d--S-----T d2750=d--S------ d4755=d--S------ d600=d--S------ d644=d--S------ d755=d--S------"),
			("g=s", "f000=------S--- f1777=-rwx--Srwt f2750=-rwx--S--- f4755=-rws--Sr-x f600=-rw---S--- f644=-rw---Sr-- f755=-rwx--Sr-x d000=d-----S--- d1777=drwx--Srwt d2750=drwx--S--- d4755=drws--Sr-x d600=drw---S--- d644=drw---Sr-- d755=drwx--Sr-x"),
			("o=t", "f000=---------T f1777=-rwxrwx--T f2750=-rwxr-x--T f4755=-rwsr-x--T f600=-rw------T f644=-rw-r----T f755=-rwxr-x--T d000=d--------T d1777=drwxrwx--T d2750=drwxr-x--T d4755=drwsr-x--T d600=drw------T d644=drw-r----T d755=drwxr-x--T"),
			("go=", "f000=---------- f1777=-rwx-----T f2750=-rwx------ f4755=-rws------ f600=-rw------- f644=-rw------- f755=-rwx------ d000=d--------- d1777=drwx-----T d2750=drwx------ d4755=drws------ d600=drw------- d644=drw------- d755=drwx------"),
			("+", "f000=---------- f1777=-rwxrwxrwt f2750=-rwxr-x--- f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--------- d1777=drwxrwxrwt d2750=drwxr-x--- d4755=drwsr-xr-x d600=drw------- d644=drw-r--r-- d755=drwxr-xr-x"),
			("u+rwx,g-w,o=", "f000=-rwx------ f1777=-rwxr-x--T f2750=-rwxr-x--- f4755=-rwsr-x--- f600=-rwx------ f644=-rwxr----- f755=-rwxr-x--- d000=drwx------ d1777=drwxr-x--T d2750=drwxr-x--- d4755=drwsr-x--- d600=drwx------ d644=drwxr----- d755=drwxr-x---"),
			// X looks at the mode before any clause ran.
			("u+x,a+X", "f000=---x------ f1777=-rwxrwxrwt f2750=-rwxr-x--x f4755=-rwsr-xr-x f600=-rwx------ f644=-rwxr--r-- f755=-rwxr-xr-x d000=d--x--x--x d1777=drwxrwxrwt d2750=drwxr-x--x d4755=drwsr-xr-x d600=drwx--x--x d644=drwxr-xr-x d755=drwxr-xr-x"),
			("+xX", "f000=---------- f1777=-rwxrwxrwt f2750=-rwxr-x--x f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--x--x--x d1777=drwxrwxrwt d2750=drwxr-x--x d4755=drwsr-xr-x d600=drwx--x--x d644=drwxr-xr-x d755=drwxr-xr-x"),
			("a+X,u-x", "f000=---------- f1777=-rw-rwxrwt f2750=-rw-r-x--x f4755=-rwSr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rw-r-xr-x d000=d-----x--x d1777=drw-rwxrwt d2750=drw-r-x--x d4755=drwSr-xr-x d600=drw---x--x d644=drw-r-xr-x d755=drw-r-xr-x"),
			("D-X", "f000=---------- f1777=-rwxrwxrwt f2750=-rwxr-x--- f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--------- d1777=drw-rw-rwT d2750=drw-r----- d4755=drwSr--r-- d600=drw------- d644=drw-r--r-- d755=drw-r--r--"),
			("F=X", "f000=---------- f1777=---x--x--t f2750=---x--x--x f4755=---s--x--x f600=---------- f644=---------- f755=---x--x--x d000=d--------- d1777=drwxrwxrwt d2750=drwxr-x--- d4755=drwsr-xr-x d600=drw------- d644=drw-r--r-- d755=drwxr-xr-x"),
			("g=o,o+X", "f000=---------- f1777=-rwxrwxrwt f2750=-rwx-----x f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--------x d1777=drwxrwxrwt d2750=drwx-----x d4755=drwsr-xr-x d600=drw------x d644=drw-r--r-x d755=drwxr-xr-x"),
		]);
	}

	#[test]
	fn golden_umask_027() {
		check_rows(0o027, &[
			("+x", "f000=---x--x--- f1777=-rwxrwxrwt f2750=-rwxr-x--- f4755=-rwsr-xr-x f600=-rwx--x--- f644=-rwxr-xr-- f755=-rwxr-xr-x d000=d--x--x--- d1777=drwxrwxrwt d2750=drwxr-x--- d4755=drwsr-xr-x d600=drwx--x--- d644=drwxr-xr-- d755=drwxr-xr-x"),
			("=r", "f000=-r--r----- f1777=-r--r----T f2750=-r--r----- f4755=-r-Sr----- f600=-r--r----- f644=-r--r----- f755=-r--r----- d000=dr--r----- d1777=dr--r----T d2750=dr--r----- d4755=dr-Sr----- d600=dr--r----- d644=dr--r----- d755=dr--r-----"),
			("-w", "f000=---------- f1777=-r-xrwxrwt f2750=-r-xr-x--- f4755=-r-sr-xr-x f600=-r-------- f644=-r--r--r-- f755=-r-xr-xr-x d000=d--------- d1777=dr-xrwxrwt d2750=dr-xr-x--- d4755=dr-sr-xr-x d600=dr-------- d644=dr--r--r-- d755=dr-xr-xr-x"),
			("+w", "f000=--w------- f1777=-rwxrwxrwt f2750=-rwxr-x--- f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d-w------- d1777=drwxrwxrwt d2750=drwxr-x--- d4755=drwsr-xr-x d600=drw------- d644=drw-r--r-- d755=drwxr-xr-x"),
			("o=u", "f000=---------- f1777=-rwxrwxrwx f2750=-rwxr-xrwx f4755=-rwsr-xrwx f600=-rw----rw- f644=-rw-r--rw- f755=-rwxr-xrwx d000=d--------- d1777=drwxrwxrwx d2750=drwxr-xrwx d4755=drwsr-xrwx d600=drw----rw- d644=drw-r--rw- d755=drwxr-xrwx"),
			("-rwx", "f000=---------- f1777=-----w-rwt f2750=---------- f4755=---S---r-x f600=---------- f644=-------r-- f755=-------r-x d000=d--------- d1777=d----w-rwt d2750=d--------- d4755=d--S---r-x d600=d--------- d644=d------r-- d755=d------r-x"),
			("=rwx", "f000=-rwxr-x--- f1777=-rwxr-x--T f2750=-rwxr-x--- f4755=-rwsr-x--- f600=-rwxr-x--- f644=-rwxr-x--- f755=-rwxr-x--- d000=drwxr-x--- d1777=drwxr-x--T d2750=drwxr-x--- d4755=drwsr-x--- d600=drwxr-x--- d644=drwxr-x--- d755=drwxr-x---"),
			("+X", "f000=---------- f1777=-rwxrwxrwt f2750=-rwxr-x--- f4755=-rwsr-xr-x f600=-rw------- f644=-rw-r--r-- f755=-rwxr-xr-x d000=d--x--x--- d1777=drwxrwxrwt d2750=drwxr-x--- d4755=drwsr-xr-x d600=drwx--x--- d644=drwxr-xr-- d755=drwxr-xr-x"),
			("=u", "f000=---------- f1777=-rwxr-x--- f2750=-rwxr-x--- f4755=-rwxr-x--- f600=-rw-r----- f644=-rw-r----- f755=-rwxr-x--- d000=d--------- d1777=drwxr-x--- d2750=drwxr-x--- d4755=drwxr-x--- d600=drw-r----- d644=drw-r----- d755=drwxr-x---"),
			("-u", "f000=---------- f1777=-----w-rwt f2750=---------- f4755=---S---r-x f600=---------- f644=-------r-- f755=-------r-x d000=d--------- d1777=d----w-rwt d2750=d--------- d4755=d--S---r-x d600=d--------- d644=d------r-- d755=d------r-x"),
			("a=u", "f000=---------- f1777=-rwxrwxrwx f2750=-rwxrwxrwx f4755=-rwxrwxrwx f600=-rw-rw-rw- f644=-rw-rw-rw- f755=-rwxrwxrwx d000=d--------- d1777=drwxrwxrwx d2750=drwxrwxrwx d4755=drwxrwxrwx d600=drw-rw-rw- d644=drw-rw-rw- d755=drwxrwxrwx"),
			("ug=o", "f000=---------- f1777=-rwxrwxrwt f2750=---------- f4755=-r-xr-xr-x f600=---------- f644=-r--r--r-- f755=-r-xr-xr-x d000=d--------- d1777=drwxrwxrwt d2750=d--------- d4755=dr-xr-xr-x d600=d--------- d644=dr--r--r-- d755=dr-xr-xr-x"),
			("o-u", "f000=---------- f1777=-rwxrwx--T f2750=-rwxr-x--- f4755=-rwsr-x--- f600=-rw------- f644=-rw-r----- f755=-rwxr-x--- d000=d--------- d1777=drwxrwx--T d2750=drwxr-x--- d4755=drwsr-x--- d600=drw------- d644=drw-r----- d755=drwxr-x---"),
			("=", "f000=---------- f1777=---------T f2750=---------- f4755=---S------ f600=---------- f644=---------- f755=---------- d000=d--------- d1777=d--------T d2750=d--------- d4755=d--S------ d600=d--------- d644=d--------- d755=d---------"),
		]);
	}

	#[test]
	fn accepts_upstream_grammar() {
		for spec in [
			"u=g", "g=u,o=u", "07777", "u+rs", "u+X", "u=g,u=o", "Du+x", "DD+x", "uD+x", "1",
			"12", "644", "0644", "00644", "D644", "F0644", "+", "u+", "D+", "FF=",
		] {
			assert!(ChmodRules::parse_with_umask(spec, None, 0o022).is_ok(), "{spec}");
		}
	}

	#[test]
	fn rejects_with_upstream_message() {
		for spec in [
			"bogus", "D", "u+r,", ",u+x", "u+x,,g+x", "", "DF+x", "FD+x", "8644", "017777",
			"u=gs", "u+gr", "u+rg", "u+Dx", "a+w-x", "u+r+w", "x", "r", "u644", "go=u-w", "u=gg",
			"64a", "u+ x",
		] {
			let err = ChmodRules::parse_with_umask(spec, None, 0o022).unwrap_err();
			assert_eq!(err, format!("Invalid argument passed to --chmod ({spec})"));
		}
	}

	#[test]
	fn multiple_options_accumulate_in_order() {
		let first = ChmodRules::parse_with_umask("u=rw", None, 0o022).unwrap();
		let both = ChmodRules::parse_with_umask("g+w", Some(first.clone()), 0o022).unwrap();
		assert_eq!(both.apply(0o100000), 0o100620);
		// A later clause sees the earlier clause's result.
		let rules = ChmodRules::parse_with_umask("o=u", Some(first), 0o022).unwrap();
		assert_eq!(rules.apply(0o100755), 0o100656);
		// One bad clause rejects the whole argument.
		let base = ChmodRules::parse_with_umask("F600", None, 0o022).unwrap();
		let err = ChmodRules::parse_with_umask("u+x,bad", Some(base), 0o022).unwrap_err();
		assert_eq!(err, "Invalid argument passed to --chmod (u+x,bad)");
	}

	#[test]
	fn type_bits_survive_and_select_scope() {
		let rules = ChmodRules::parse_with_umask("D700,F600", None, 0).unwrap();
		assert_eq!(rules.apply(0o040755), 0o040700);
		assert_eq!(rules.apply(0o100755), 0o100600);
		// Every non-directory (fifos, devices) counts as a file.
		assert_eq!(rules.apply(0o010644), 0o010600);
		assert_eq!(ChmodRules::default().apply(0o100755), 0o100755);
	}
}
