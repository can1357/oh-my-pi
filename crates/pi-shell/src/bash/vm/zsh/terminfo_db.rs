//! The terminal capability database: a reader for compiled ncurses terminfo
//! entries and the ncurses routines zsh calls on them (`tigetflag`,
//! `tigetnum`, `tigetstr`, `tgetflag`, `tgetnum`, `tgetstr`, `tparm`,
//! `tgoto`, `tputs`), with ncurses' behaviour where zsh's output depends on
//! it.
//!
//! [`load`] searches the database like ncurses (`$TERMINFO`,
//! `$HOME/.terminfo`, `$TERMINFO_DIRS` whose empty entries name the system
//! directory, then the system directories), reads both the legacy (`0432`)
//! and the 32-bit-number (`01036`) formats with their extended (user
//! defined) capabilities, and applies what `setupterm` + `tgetent` do to the
//! entry (screen-size fallback, `OTbs`/`OTbc`, the obsolete termcap
//! defaults, the termcap `me` fix-up of `_nc_trim_sgr0`). Entries are read
//! with `std::fs`, as ncurses does, and cached for the process.
//!
//! Modelled on ncurses 6.0 (`tinfo/read_entry.c`, `db_iterator.c`,
//! `lib_ti.c`, `lib_termcap.c`, `lib_tparm.c`, `lib_tgoto.c`, `lib_tputs.c`,
//! `trim_sgr0.c`, `include/capdefaults.c`, `include/Caps`; MIT-style licence,
//! Copyright (c) 1998-2015 Free Software Foundation, Inc.), the library
//! zsh 5.9 links on the reference host.

use std::{
	collections::HashMap,
	path::PathBuf,
	sync::{Arc, LazyLock, Mutex, PoisonError},
};

/// ncurses' boolean capability names (`boolnames`), in index order.
const BOOL_NAMES: &str = "bw am xsb xhp xenl eo gn hc km hs in da db mir msgr os eslok xt hz ul \
                          xon nxon mc5i chts nrrmc npc ndscr ccc bce hls xhpa crxm daisy xvpa sam \
                          cpix lpix OTbs OTns OTnc OTMT OTNL OTpt OTxr";

/// ncurses' boolean termcap codes (`boolcodes`), in index order.
const BOOL_CODES: &str = "bw am xb xs xn eo gn hc km hs in da db mi ms os es xt hz ul xo nx 5i HC \
                          NR NP ND cc ut hl YA YB YC YD YE YF YG bs ns nc MT NL pt xr";

/// ncurses' numeric capability names (`numnames`), in index order.
const NUM_NAMES: &str = "cols it lines lm xmc pb vt wsl nlab lh lw ma wnum colors pairs ncv bufsz \
                         spinv spinh maddr mjump mcs mls npins orc orl orhi orvi cps widcs btns \
                         bitwin bitype OTug OTdC OTdN OTdB OTdT OTkn";

/// ncurses' numeric termcap codes (`numcodes`), in index order.
const NUM_CODES: &str = "co it li lm sg pb vt ws Nl lh lw ma MW Co pa NC Ya Yb Yc Yd Ye Yf Yg Yh \
                         Yi Yj Yk Yl Ym Yn BT Yo Yp ug dC dN dB dT kn";

/// ncurses' string capability names (`strnames`), in index order.
const STR_NAMES: &str =
	"cbt bel cr csr tbc clear el ed hpa cmdch cup cud1 home civis cub1 mrcup cnorm cuf1 ll cuu1 \
	 cvvis dch1 dl1 dsl hd smacs blink bold smcup smdc dim smir invis prot rev smso smul ech rmacs \
	 sgr0 rmcup rmdc rmir rmso rmul flash ff fsl is1 is2 is3 if ich1 il1 ip kbs ktbc kclr kctab \
	 kdch1 kdl1 kcud1 krmir kel ked kf0 kf1 kf10 kf2 kf3 kf4 kf5 kf6 kf7 kf8 kf9 khome kich1 kil1 \
	 kcub1 kll knp kpp kcuf1 kind kri khts kcuu1 rmkx smkx lf0 lf1 lf10 lf2 lf3 lf4 lf5 lf6 lf7 \
	 lf8 lf9 rmm smm nel pad dch dl cud ich indn il cub cuf rin cuu pfkey pfloc pfx mc0 mc4 mc5 \
	 rep rs1 rs2 rs3 rf rc vpa sc ind ri sgr hts wind ht tsl uc hu iprog ka1 ka3 kb2 kc1 kc3 mc5p \
	 rmp acsc pln kcbt smxon rmxon smam rmam xonc xoffc enacs smln rmln kbeg kcan kclo kcmd kcpy \
	 kcrt kend kent kext kfnd khlp kmrk kmsg kmov knxt kopn kopt kprv kprt krdo kref krfr krpl \
	 krst kres ksav kspd kund kBEG kCAN kCMD kCPY kCRT kDC kDL kslt kEND kEOL kEXT kFND kHLP kHOM \
	 kIC kLFT kMSG kMOV kNXT kOPT kPRV kPRT kRDO kRPL kRIT kRES kSAV kSPD kUND rfi kf11 kf12 kf13 \
	 kf14 kf15 kf16 kf17 kf18 kf19 kf20 kf21 kf22 kf23 kf24 kf25 kf26 kf27 kf28 kf29 kf30 kf31 \
	 kf32 kf33 kf34 kf35 kf36 kf37 kf38 kf39 kf40 kf41 kf42 kf43 kf44 kf45 kf46 kf47 kf48 kf49 \
	 kf50 kf51 kf52 kf53 kf54 kf55 kf56 kf57 kf58 kf59 kf60 kf61 kf62 kf63 el1 mgc smgl smgr fln \
	 sclk dclk rmclk cwin wingo hup dial qdial tone pulse hook pause wait u0 u1 u2 u3 u4 u5 u6 u7 \
	 u8 u9 op oc initc initp scp setf setb cpi lpi chr cvr defc swidm sdrfq sitm slm smicm snlq \
	 snrmq sshm ssubm ssupm sum rwidm ritm rlm rmicm rshm rsubm rsupm rum mhpa mcud1 mcub1 mcuf1 \
	 mvpa mcuu1 porder mcud mcub mcuf mcuu scs smgb smgbp smglp smgrp smgt smgtp sbim scsd rbim \
	 rcsd subcs supcs docr zerom csnm kmous minfo reqmp getm setaf setab pfxl devt csin s0ds s1ds \
	 s2ds s3ds smglr smgtb birep binel bicr colornm defbi endbi setcolor slines dispc smpch rmpch \
	 smsc rmsc pctrm scesc scesa ehhlm elhlm elohlm erhlm ethlm evhlm sgr1 slength OTi2 OTrs OTnl \
	 OTbc OTko OTma OTG2 OTG3 OTG1 OTG4 OTGR OTGL OTGU OTGD OTGH OTGV OTGC meml memu box1";

/// ncurses' string termcap codes (`strcodes`), in index order.
const STR_CODES: &str =
	"bt bl cr cs ct cl ce cd ch CC cm do ho vi le CM ve nd ll up vs dc dl ds hd as mb md ti dm mh \
	 im mk mp mr so us ec ae me te ed ei se ue vb ff fs i1 is i3 if ic al ip kb ka kC kt kD kL kd \
	 kM kE kS k0 k1 k; k2 k3 k4 k5 k6 k7 k8 k9 kh kI kA kl kH kN kP kr kF kR kT ku ke ks l0 l1 la \
	 l2 l3 l4 l5 l6 l7 l8 l9 mo mm nw pc DC DL DO IC SF AL LE RI SR UP pk pl px ps pf po rp r1 r2 \
	 r3 rf rc cv sc sf sr sa st wi ta ts uc hu iP K1 K3 K2 K4 K5 pO rP ac pn kB SX RX SA RA XN XF \
	 eA LO LF @1 @2 @3 @4 @5 @6 @7 @8 @9 @0 %1 %2 %3 %4 %5 %6 %7 %8 %9 %0 &1 &2 &3 &4 &5 &6 &7 &8 \
	 &9 &0 *1 *2 *3 *4 *5 *6 *7 *8 *9 *0 #1 #2 #3 #4 %a %b %c %d %e %f %g %h %i %j !1 !2 !3 RF F1 \
	 F2 F3 F4 F5 F6 F7 F8 F9 FA FB FC FD FE FF FG FH FI FJ FK FL FM FN FO FP FQ FR FS FT FU FV FW \
	 FX FY FZ Fa Fb Fc Fd Fe Ff Fg Fh Fi Fj Fk Fl Fm Fn Fo Fp Fq Fr cb MC ML MR Lf SC DK RC CW WG \
	 HU DI QD TO PU fh PA WA u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 op oc Ic Ip sp Sf Sb ZA ZB ZC ZD ZE ZF \
	 ZG ZH ZI ZJ ZK ZL ZM ZN ZO ZP ZQ ZR ZS ZT ZU ZV ZW ZX ZY ZZ Za Zb Zc Zd Ze Zf Zg Zh Zi Zj Zk \
	 Zl Zm Zn Zo Zp Zq Zr Zs Zt Zu Zv Zw Zx Zy Km Mi RQ Gm AF AB xl dv ci s0 s1 s2 s3 ML MT Xy Zz \
	 Yv Yw Yx Yy Yz YZ S1 S2 S3 S4 S5 S6 S7 S8 Xh Xl Xo Xr Xt Xv sA YI i2 rs nl bc ko ma G2 G3 G1 \
	 G4 GR GL GU GD GH GV GC ml mu bx";

/// Number of standard boolean capabilities (`BOOLCOUNT`).
const BOOLCOUNT: usize = 44;
/// Number of standard numeric capabilities (`NUMCOUNT`).
const NUMCOUNT: usize = 39;
/// Number of standard string capabilities (`STRCOUNT`).
const STRCOUNT: usize = 414;

/// ncurses' boolean capability names in index order (zsh's `scanterminfo`
/// walks them).
pub fn bool_names() -> std::str::SplitAsciiWhitespace<'static> {
	BOOL_NAMES.split_ascii_whitespace()
}

/// ncurses' numeric capability names in index order.
pub fn num_names() -> std::str::SplitAsciiWhitespace<'static> {
	NUM_NAMES.split_ascii_whitespace()
}

/// ncurses' string capability names in index order.
pub fn str_names() -> std::str::SplitAsciiWhitespace<'static> {
	STR_NAMES.split_ascii_whitespace()
}

/// ncurses' boolean termcap codes in index order (zsh's `scantermcap`
/// walks them).
pub fn bool_codes() -> std::str::SplitAsciiWhitespace<'static> {
	BOOL_CODES.split_ascii_whitespace()
}

/// ncurses' numeric termcap codes in index order.
pub fn num_codes() -> std::str::SplitAsciiWhitespace<'static> {
	NUM_CODES.split_ascii_whitespace()
}

/// ncurses' string termcap codes in index order.
pub fn str_codes() -> std::str::SplitAsciiWhitespace<'static> {
	STR_CODES.split_ascii_whitespace()
}

/// Whether the first two bytes of `code` are a standard boolean termcap
/// code (the test of zsh's `ztgetflag`).
pub fn is_bool_code(code: &[u8]) -> bool {
	bool_codes().any(|c| same_tc(code, c.as_bytes()))
}

/// The index of `name` in the capability-name table `table`.
fn name_index(table: &'static str, name: &[u8]) -> Option<usize> {
	table
		.split_ascii_whitespace()
		.position(|n| n.as_bytes() == name)
}

/// The index of an exact capability name that must exist (internal use).
fn idx(table: &'static str, name: &str) -> usize {
	name_index(table, name.as_bytes()).unwrap_or(usize::MAX)
}

/// The byte at `i`, NUL past the end (C string reads).
fn at(s: &[u8], i: usize) -> u8 {
	s.get(i).copied().unwrap_or(0)
}

/// `s` up to its first NUL (what C sees of it).
fn cstr(s: &[u8]) -> &[u8] {
	s.iter().position(|&c| c == 0).map_or(s, |n| &s[..n])
}

/// ncurses `ValidCap`: the termcap code has two non-NUL bytes.
fn valid_cap(id: &[u8]) -> bool {
	at(id, 0) != 0 && at(id, 1) != 0
}

/// ncurses `same_tcname` (`SameCap`): the first two bytes agree.
fn same_tc(id: &[u8], cap: &[u8]) -> bool {
	at(id, 0) == at(cap, 0) && at(id, 1) == at(cap, 1)
}

/// The standard termcap index for `id` in `table`: ncurses'
/// `_nc_find_type_entry(id, type, TRUE)` hash chain finds the last entry
/// of the table with those two bytes.
fn tc_index(table: &'static str, id: &[u8]) -> Option<usize> {
	let mut found = None;
	for (i, c) in table.split_ascii_whitespace().enumerate() {
		if same_tc(id, c.as_bytes()) {
			found = Some(i);
		}
	}
	found
}

/// ncurses' `ABSENT_NUMERIC`.
const ABSENT: i32 = -1;

/// A compiled terminal description, as ncurses holds it after `tgetent`.
#[derive(Clone, Debug)]
pub struct TermInfo {
	/// Standard booleans, then the extended ones.
	bools:     Vec<bool>,
	/// Standard numbers, then the extended ones (-1 absent, -2 cancelled).
	nums:      Vec<i32>,
	/// Standard strings, then the extended ones (`None`: absent or
	/// cancelled).
	strs:      Vec<Option<Vec<u8>>>,
	/// Names of the extended booleans.
	ext_bools: Vec<Vec<u8>>,
	/// Names of the extended numbers.
	ext_nums:  Vec<Vec<u8>>,
	/// Names of the extended strings.
	ext_strs:  Vec<Vec<u8>>,
	/// `tgetent`'s `FIX_SGR0`: what `tgetstr("me")` gives instead of
	/// `sgr0` when that differs.
	fix_sgr0:  Option<Vec<u8>>,
}

impl TermInfo {
	/// The boolean slot named `name` (terminfo name, standard or
	/// extended).
	fn bool_slot(&self, name: &[u8]) -> Option<usize> {
		name_index(BOOL_NAMES, name).or_else(|| {
			self
				.ext_bools
				.iter()
				.position(|n| n == name)
				.map(|j| BOOLCOUNT + j)
		})
	}

	/// The numeric slot named `name`.
	fn num_slot(&self, name: &[u8]) -> Option<usize> {
		name_index(NUM_NAMES, name).or_else(|| {
			self
				.ext_nums
				.iter()
				.position(|n| n == name)
				.map(|j| NUMCOUNT + j)
		})
	}

	/// The string slot named `name`.
	fn str_slot(&self, name: &[u8]) -> Option<usize> {
		name_index(STR_NAMES, name).or_else(|| {
			self
				.ext_strs
				.iter()
				.position(|n| n == name)
				.map(|j| STRCOUNT + j)
		})
	}

	/// ncurses `tigetflag`: `None` when `capname` is no boolean capability
	/// (standard or of this entry), else its value.
	pub fn flag_known(&self, capname: &(impl AsRef<[u8]> + ?Sized)) -> Option<bool> {
		let s = self.bool_slot(capname.as_ref())?;
		Some(self.bools.get(s).copied().unwrap_or(false))
	}

	/// Whether boolean capability `capname` (terminfo name: `am`, `xenl`,
	/// or an extended one like `AX`) is set.
	pub fn flag(&self, capname: &(impl AsRef<[u8]> + ?Sized)) -> bool {
		self.flag_known(capname).unwrap_or(false)
	}

	/// ncurses `tigetnum` when it yields a value: numeric capability
	/// `capname` (`cols`, `colors`), `None` when absent, cancelled or no
	/// numeric capability.
	pub fn num(&self, capname: &(impl AsRef<[u8]> + ?Sized)) -> Option<i32> {
		let s = self.num_slot(capname.as_ref())?;
		self.nums.get(s).copied().filter(|&n| n >= 0)
	}

	/// ncurses `tigetstr` when it yields a string: string capability
	/// `capname` (`cup`, `sgr0`, `Ms`) raw, `$<n>` padding included.
	pub fn str(&self, capname: &(impl AsRef<[u8]> + ?Sized)) -> Option<&[u8]> {
		let s = self.str_slot(capname.as_ref())?;
		self.strs.get(s)?.as_deref()
	}

	/// ncurses `tgetflag`: boolean termcap code `code` (`am`, `xn`, `bs`;
	/// two-letter extended names too). Only its first two bytes count.
	pub fn tc_flag(&self, code: &(impl AsRef<[u8]> + ?Sized)) -> bool {
		let id = code.as_ref();
		if !valid_cap(id) {
			return false;
		}
		let slot = tc_index(BOOL_CODES, id).or_else(|| {
			self
				.ext_bools
				.iter()
				.position(|n| same_tc(id, n) && n.len() == 2)
				.map(|j| BOOLCOUNT + j)
		});
		slot
			.and_then(|s| self.bools.get(s).copied())
			.unwrap_or(false)
	}

	/// ncurses `tgetnum`: numeric termcap code `code` (`co`, `Co`, `sg`),
	/// `None` when absent.
	pub fn tc_num(&self, code: &(impl AsRef<[u8]> + ?Sized)) -> Option<i32> {
		let id = code.as_ref();
		if !valid_cap(id) {
			return None;
		}
		let slot = tc_index(NUM_CODES, id).or_else(|| {
			self
				.ext_nums
				.iter()
				.position(|n| same_tc(id, n) && n.len() == 2)
				.map(|j| NUMCOUNT + j)
		})?;
		self.nums.get(slot).copied().filter(|&n| n >= 0)
	}

	/// ncurses `tgetstr`: string termcap code `code` (`cm`, `le`, `me`,
	/// `AF`), `None` when absent; `me` is `tgetent`'s trimmed `sgr0`.
	pub fn tc_str(&self, code: &(impl AsRef<[u8]> + ?Sized)) -> Option<Vec<u8>> {
		let id = code.as_ref();
		if !valid_cap(id) {
			return None;
		}
		let slot = tc_index(STR_CODES, id).or_else(|| {
			self
				.ext_strs
				.iter()
				.position(|n| same_tc(id, n) && n.len() == 2)
				.map(|j| STRCOUNT + j)
		})?;
		let s = self.strs.get(slot)?.as_deref()?;
		if slot == idx(STR_NAMES, "sgr0")
			&& let Some(fix) = &self.fix_sgr0
		{
			return Some(fix.clone());
		}
		Some(s.to_vec())
	}

	/// The names of the entry's extended string capabilities, in the
	/// compiled entry's order (ncurses numbers extended keys by it).
	pub fn ext_str_names(&self) -> &[Vec<u8>] {
		&self.ext_strs
	}

	/// The termcap `BC` global `tgetent` exports (`OTbc`, set when `cub1`
	/// is not `^H`); [`tgoto_bc`] uses it.
	pub fn bc(&self) -> Option<&[u8]> {
		self.strs.get(idx(STR_NAMES, "OTbc"))?.as_deref()
	}

	/// The entry with `lines`/`cols` replaced, as ncurses'
	/// `_nc_get_screensize` does from the tty's window size or `$LINES` /
	/// `$COLUMNS` (values `<= 0` keep the entry's).
	#[must_use]
	pub fn with_size(self: &Arc<Self>, lines: i32, cols: i32) -> Arc<Self> {
		let li = idx(NUM_NAMES, "lines");
		let co = idx(NUM_NAMES, "cols");
		let want_li = if lines > 0 { lines } else { self.nums[li] };
		let want_co = if cols > 0 { cols } else { self.nums[co] };
		if want_li == self.nums[li] && want_co == self.nums[co] {
			return Arc::clone(self);
		}
		let mut t = (**self).clone();
		t.nums[li] = want_li;
		t.nums[co] = want_co;
		Arc::new(t)
	}

	/// A string capability by standard index.
	fn s(&self, name: &str) -> Option<&[u8]> {
		self.strs.get(idx(STR_NAMES, name))?.as_deref()
	}

	/// The entry as a failed `tgetent` leaves ncurses holding it: its
	/// changes to the description stay, `FIX_SGR0` is cleared (`tgetstr("me")`
	/// is `sgr0` again).
	#[must_use]
	pub fn without_fix_sgr0(self: &Arc<Self>) -> Arc<Self> {
		if self.fix_sgr0.is_none() {
			return Arc::clone(self);
		}
		let mut t = (**self).clone();
		t.fix_sgr0 = None;
		Arc::new(t)
	}

	/// What `setupterm` does to a freshly read entry: `_nc_get_screensize`
	/// with neither tty nor environment (the entry's size, else 24x80).
	fn setupterm(&mut self) {
		for (name, dflt) in [("lines", 24), ("cols", 80)] {
			let i = idx(NUM_NAMES, name);
			if self.nums[i] <= 0 {
				self.nums[i] = dflt;
			}
		}
	}

	/// What `tgetent` does to the entry `setupterm` set up: `OTbs`/`OTbc`
	/// from `cub1`, `FIX_SGR0`, `capdefaults.c`.
	fn tgetent(&mut self) {
		if let Some(left) = self.s("cub1").map(<[u8]>::to_vec) {
			let bs = left == b"\x08";
			self.bools[idx(BOOL_NAMES, "OTbs")] = bs;
			if !bs {
				self.strs[idx(STR_NAMES, "OTbc")] = Some(left);
			}
		}
		if let (Some(sgr0), Some(sgr)) = (self.s("sgr0"), self.s("sgr")) {
			self.fix_sgr0 = trim_sgr0(sgr0, sgr, self.s("smacs"), self.s("rmacs"))
				.filter(|fix| fix.as_slice() != sgr0);
		}
		self.capdefaults();
	}

	/// ncurses `include/capdefaults.c`: the obsolete capabilities computed
	/// from current ones.
	fn capdefaults(&mut self) {
		/// `EXTRACT_DELAY`: `atoi` after the first `*`.
		fn delay(s: &[u8]) -> i32 {
			s.iter()
				.position(|&c| c == b'*')
				.map_or(0, |p| atoi(&s[p + 1..]))
		}
		let num = |t: &mut Self, name: &str, v: i32| {
			if v != 0 {
				t.nums[idx(NUM_NAMES, name)] = i32::from(v as i16);
			}
		};
		if let Some(d) = self.s("cr").map(delay) {
			num(self, "OTdC", d);
		}
		if let Some(d) = self.s("nel").map(delay) {
			num(self, "OTdN", d);
		}
		if self.s("OTi2").is_none() && self.s("is3").is_some() {
			let v = self.strs[idx(STR_NAMES, "is3")].take();
			self.strs[idx(STR_NAMES, "OTi2")] = v;
		}
		if self.s("OTrs").is_none()
			&& self.s("rs2").is_some()
			&& self.s("rs1").is_none()
			&& self.s("rs3").is_none()
		{
			let v = self.strs[idx(STR_NAMES, "rs2")].take();
			self.strs[idx(STR_NAMES, "OTrs")] = v;
		}
		let ug = idx(NUM_NAMES, "OTug");
		let xmc = self.nums[idx(NUM_NAMES, "xmc")];
		if self.nums[ug] == ABSENT && xmc != ABSENT && self.s("smul").is_some() {
			self.nums[ug] = xmc;
		}
		self.bools[idx(BOOL_NAMES, "OTNL")] = self.s("nel") == Some(&b"\n"[..]);
		if let Some(d) = self.s("cub1").map(delay) {
			num(self, "OTdB", d);
		}
		if let Some(d) = self.s("ht").map(delay) {
			num(self, "OTdT", d);
		}
	}
}

/// C `atoi`: optional blanks and sign, then digits.
fn atoi(s: &[u8]) -> i32 {
	let mut i = 0;
	while matches!(at(s, i), b' ' | b'\t' | b'\n' | b'\x0b' | b'\x0c' | b'\r') {
		i += 1;
	}
	let neg = at(s, i) == b'-';
	if matches!(at(s, i), b'-' | b'+') {
		i += 1;
	}
	let mut n: i32 = 0;
	while at(s, i).is_ascii_digit() {
		n = n.wrapping_mul(10).wrapping_add(i32::from(at(s, i) - b'0'));
		i += 1;
	}
	if neg { n.wrapping_neg() } else { n }
}

// ---------------------------------------------------------------------------
// Reading compiled entries (`read_entry.c`).

/// Legacy compiled format magic (`0432`).
const MAGIC: u16 = 0o432;
/// 32-bit numbers compiled format magic (`01036`, ncurses 6.1+).
const MAGIC2: u16 = 0o1036;
/// Largest entry ncurses reads (`MAX_ENTRY_SIZE` of the extended format).
const MAX_ENTRY_SIZE: usize = 32768;
/// Longest names line (`MAX_NAME_SIZE`).
const MAX_NAME_SIZE: usize = 512;

/// A cursor over the entry's bytes.
struct Reader<'a> {
	buf: &'a [u8],
	pos: usize,
}

impl<'a> Reader<'a> {
	/// The next `n` bytes, if present.
	fn take(&mut self, n: usize) -> Option<&'a [u8]> {
		let end = self.pos.checked_add(n)?;
		let s = self.buf.get(self.pos..end)?;
		self.pos = end;
		Some(s)
	}

	/// The next `n` little-endian 16-bit values.
	fn shorts(&mut self, n: usize) -> Option<Vec<i16>> {
		let raw = self.take(n.checked_mul(2)?)?;
		Some(
			raw.as_chunks::<2>()
				.0
				.iter()
				.map(|c| i16::from_le_bytes([c[0], c[1]]))
				.collect(),
		)
	}

	/// The next `n` numbers of `width` bytes (2: legacy, 4: 32-bit).
	fn numbers(&mut self, n: usize, width: usize) -> Option<Vec<i32>> {
		let raw = self.take(n.checked_mul(width)?)?;
		Some(if width == 4 {
			raw.as_chunks::<4>()
				.0
				.iter()
				.map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
				.collect()
		} else {
			raw.as_chunks::<2>()
				.0
				.iter()
				.map(|c| i32::from(i16::from_le_bytes([c[0], c[1]])))
				.collect()
		})
	}

	/// ncurses `even_boundary`: skip a pad byte after an odd count.
	const fn even(&mut self, n: usize) {
		if !n.is_multiple_of(2) {
			self.pos += 1;
		}
	}
}

/// ncurses `convert_strings`: offsets into `table` (of `size` bytes) to
/// NUL-terminated strings; -1, -2, out-of-range or unterminated: none.
fn convert_strings(offsets: &[i16], table: &[u8], size: usize) -> Vec<Option<Vec<u8>>> {
	offsets
		.iter()
		.map(|&off| {
			let off = usize::try_from(off).ok()?;
			if off > size {
				return None;
			}
			let tail = table.get(off..size.min(table.len()))?;
			let n = tail.iter().position(|&c| c == 0)?;
			Some(tail[..n].to_vec())
		})
		.collect()
}

/// ncurses `_nc_read_termtype`: parse a compiled entry.
fn parse(buf: &[u8]) -> Option<TermInfo> {
	let mut r = Reader { buf, pos: 0 };
	let head = r.shorts(6)?;
	let width = match head[0] as u16 {
		MAGIC => 2,
		MAGIC2 => 4,
		_ => return None,
	};
	let count = |v: i16| usize::try_from(v).ok();
	let name_size = count(head[1])?;
	let bool_count = count(head[2])?;
	let num_count = count(head[3])?;
	let mut str_count = count(head[4])?;
	let str_size = count(head[5])?;
	if str_size == 0 {
		str_count = 0;
	} else if str_count * 2 >= MAX_ENTRY_SIZE {
		return None;
	}
	r.take(name_size.min(MAX_NAME_SIZE))?;
	r.pos += name_size - name_size.min(MAX_NAME_SIZE);
	let bools_raw = r.take(bool_count)?;
	r.even(name_size + bool_count);
	let nums_raw = r.numbers(num_count, width)?;
	let mut info = TermInfo {
		bools:     vec![false; BOOLCOUNT],
		nums:      vec![ABSENT; NUMCOUNT],
		strs:      vec![None; STRCOUNT],
		ext_bools: Vec::new(),
		ext_nums:  Vec::new(),
		ext_strs:  Vec::new(),
		fix_sgr0:  None,
	};
	for (slot, &b) in info.bools.iter_mut().zip(bools_raw) {
		*slot = b == 1;
	}
	for (slot, &n) in info.nums.iter_mut().zip(&nums_raw) {
		*slot = n;
	}
	if str_count > 0 {
		let offsets = r.shorts(str_count)?;
		let table = r.take(str_size)?;
		for (slot, s) in info
			.strs
			.iter_mut()
			.zip(convert_strings(&offsets, table, str_size))
		{
			*slot = s;
		}
	}
	// The extended section, after the string table on an even boundary.
	r.even(str_size);
	let ext = r.shorts(5).filter(|h| h.iter().all(|&v| v >= 0));
	if let Some(h) = ext {
		let [eb, en, es, ess, esl] = [h[0], h[1], h[2], h[3], h[4]].map(|v| v as usize);
		let need = eb + en + es;
		if need >= MAX_ENTRY_SIZE / 2 || ess >= MAX_ENTRY_SIZE || esl >= MAX_ENTRY_SIZE {
			return None;
		}
		let ebools = r.take(eb)?;
		r.even(eb);
		let enums = r.numbers(en, width)?;
		if es + need >= MAX_ENTRY_SIZE / 2 {
			return None;
		}
		let offsets = r.shorts(es + need)?;
		let table = r.take(esl)?;
		let values = convert_strings(&offsets[..es], table, esl);
		let base: usize = values.iter().flatten().map(|s| s.len() + 1).sum();
		let names_table = table.get(base..).unwrap_or_default();
		let mut names = convert_strings(&offsets[es..], names_table, esl)
			.into_iter()
			.map(Option::<Vec<u8>>::unwrap_or_default);
		info.bools.extend(ebools.iter().map(|&b| b == 1));
		info.nums.extend(enums);
		info.strs.extend(values);
		info.ext_bools = names.by_ref().take(eb).collect();
		info.ext_nums = names.by_ref().take(en).collect();
		info.ext_strs = names.take(es).collect();
	}
	Some(info)
}

// ---------------------------------------------------------------------------
// Finding entries (`db_iterator.c`, `_nc_read_entry`, `_nc_setupterm`).

/// The environment ncurses consults to find a description (the exported
/// values of these variables).
#[derive(Clone, Copy, Debug, Default)]
pub struct TermEnv<'a> {
	/// `$TERMINFO`: a database searched first.
	pub terminfo:      Option<&'a [u8]>,
	/// `$TERMINFO_DIRS`: colon-separated databases (an empty entry is the
	/// system database).
	pub terminfo_dirs: Option<&'a [u8]>,
	/// `$HOME`: `$HOME/.terminfo` is searched after `$TERMINFO`.
	pub home:          Option<&'a [u8]>,
}

/// The default database (`TERMINFO` at ncurses' configure time).
const SYSTEM_TERMINFO: &str = "/usr/share/terminfo";

/// The configured database list (`TERMINFO_DIRS` at configure time).
#[cfg(target_os = "macos")]
const SYSTEM_DIRS: &str = "/usr/share/terminfo";
/// The configured database list (`TERMINFO_DIRS` at configure time).
#[cfg(not(target_os = "macos"))]
const SYSTEM_DIRS: &str = "/etc/terminfo:/lib/terminfo:/usr/share/terminfo";

/// The databases to search, in order, deduplicated, existing only
/// (`_nc_first_db`).
fn search_dirs(env: &TermEnv<'_>) -> Vec<PathBuf> {
	let mut list: Vec<Vec<u8>> = Vec::new();
	if let Some(t) = env.terminfo.filter(|t| !t.is_empty()) {
		list.push(t.to_vec());
	}
	if let Some(h) = env.home {
		let mut p = h.to_vec();
		p.extend_from_slice(b"/.terminfo");
		list.push(p);
	}
	if let Some(d) = env.terminfo_dirs.filter(|d| !d.is_empty()) {
		list.extend(d.split(|&c| c == b':').map(<[u8]>::to_vec));
	}
	list.extend(
		SYSTEM_DIRS
			.as_bytes()
			.split(|&c| c == b':')
			.map(<[u8]>::to_vec),
	);
	list.push(SYSTEM_TERMINFO.as_bytes().to_vec());
	let mut out: Vec<PathBuf> = Vec::new();
	let mut seen: Vec<Vec<u8>> = Vec::new();
	#[cfg(unix)]
	let mut ids: Vec<(u64, u64)> = Vec::new();
	for mut d in list {
		if d.is_empty() {
			d = SYSTEM_TERMINFO.as_bytes().to_vec();
		}
		if seen.contains(&d) {
			continue;
		}
		seen.push(d.clone());
		let path = bytes_path(&d);
		let Ok(meta) = std::fs::metadata(&path) else {
			continue;
		};
		#[cfg(unix)]
		{
			use std::os::unix::fs::MetadataExt;
			let id = (meta.dev(), meta.ino());
			if ids.contains(&id) {
				continue;
			}
			ids.push(id);
		}
		#[cfg(not(unix))]
		let _ = meta;
		out.push(path);
	}
	out
}

/// Bytes as a path.
fn bytes_path(b: &[u8]) -> PathBuf {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt;
		PathBuf::from(std::ffi::OsStr::from_bytes(b))
	}
	#[cfg(not(unix))]
	{
		PathBuf::from(String::from_utf8_lossy(b).into_owned())
	}
}

/// Read `term`'s entry from database `dir`: `dir/X/term` with `X` the
/// first letter or its hex code (macOS' case-insensitive layout), the
/// host's layout first.
fn read_from(dir: &std::path::Path, term: &[u8]) -> Option<TermInfo> {
	let first = term[0];
	let letter = vec![first];
	let hex = format!("{first:02x}").into_bytes();
	let leaves = if cfg!(target_os = "macos") {
		[hex, letter]
	} else {
		[letter, hex]
	};
	for leaf in leaves {
		let path = dir.join(bytes_path(&leaf)).join(bytes_path(term));
		if let Ok(data) = std::fs::read(&path)
			&& let Some(info) = parse(&data)
		{
			return Some(info);
		}
	}
	None
}

/// What [`load`] caches: the inputs of one search.
#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheKey {
	/// Set up by `tgetent` ([`load`]) rather than `setupterm` only
	/// ([`load_raw`]).
	tgetent:       bool,
	term:          Vec<u8>,
	terminfo:      Option<Vec<u8>>,
	terminfo_dirs: Option<Vec<u8>>,
	home:          Option<Vec<u8>>,
}

/// The entries read so far (misses included), for the process.
static CACHE: LazyLock<Mutex<HashMap<CacheKey, Option<Arc<TermInfo>>>>> =
	LazyLock::new(Mutex::default);

/// ncurses `tgetent(NULL, term)`: the description of terminal `term`
/// searched in the databases `env` names (cached for the process), set up
/// as `setupterm` and `tgetent` leave it. `None`: no usable entry (an
/// empty or invalid name, no entry, an unreadable or corrupt one, a
/// generic type).
pub fn load(term: &[u8], env: &TermEnv<'_>) -> Option<Arc<TermInfo>> {
	cached(term, env, true)
}

/// ncurses `setupterm(term)` without `tgetent`: [`load`] without the
/// termcap adjustments (`OTbs`/`OTbc`, the `me` fix-up, the obsolete
/// capability defaults). zsh/terminfo and zsh/termcap set up the exported
/// `TERM` this way when they boot.
pub fn load_raw(term: &[u8], env: &TermEnv<'_>) -> Option<Arc<TermInfo>> {
	cached(term, env, false)
}

/// [`load`] / [`load_raw`] through the process cache.
fn cached(term: &[u8], env: &TermEnv<'_>, tgetent: bool) -> Option<Arc<TermInfo>> {
	let key = CacheKey {
		tgetent,
		term: term.to_vec(),
		terminfo: env.terminfo.map(<[u8]>::to_vec),
		terminfo_dirs: env.terminfo_dirs.map(<[u8]>::to_vec),
		home: env.home.map(<[u8]>::to_vec),
	};
	if let Some(hit) = CACHE
		.lock()
		.unwrap_or_else(PoisonError::into_inner)
		.get(&key)
	{
		return hit.clone();
	}
	let found = find(term, env, tgetent).map(Arc::new);
	CACHE
		.lock()
		.unwrap_or_else(PoisonError::into_inner)
		.insert(key, found.clone());
	found
}

/// ncurses 6.4's compiled `xterm-256color` entry, the description of a
/// Windows console ([`find`]).
const WINDOWS_CONSOLE_ENTRY: &[u8] = include_bytes!("terminfo/xterm-256color");

/// A terminal name of the xterm family (`xterm`, `xterm-256color`,
/// `xterm-kitty`, …, and the multiplexers that emulate it).
fn is_xterm_family(term: &[u8]) -> bool {
	[&b"xterm"[..], b"screen", b"tmux", b"ms-terminal", b"vt100", b"vt220"]
		.iter()
		.any(|p| term.starts_with(p))
}

/// The uncached search behind [`load`] (`tgetent`) and [`load_raw`].
fn find(term: &[u8], env: &TermEnv<'_>, tgetent: bool) -> Option<TermInfo> {
	if term.is_empty()
		|| term.len() > MAX_NAME_SIZE
		|| term == b"."
		|| term == b".."
		|| term.contains(&b'/')
		|| term.contains(&b':')
		|| term.contains(&0)
	{
		return None;
	}
	let mut info = match search_dirs(env).iter().find_map(|d| read_from(d, term)) {
		Some(info) => info,
		// Windows has no terminfo database, and every console there takes
		// xterm's escape sequences (virtual-terminal processing): a name of
		// the xterm family (what the shell sets, and what terminals that
		// emulate it export) reads as ncurses' `xterm-256color`. Any other
		// name (`dumb`, a typo) stays unknown, as without its entry.
		None if cfg!(windows) && is_xterm_family(term) => parse(WINDOWS_CONSOLE_ENTRY)?,
		None => return None,
	};
	// `_nc_setupterm` refuses a generic type unless it can address the
	// cursor and clear the screen.
	if info.flag("gn")
		&& !((info.s("cup").is_some() || (info.s("cud1").is_some() && info.s("home").is_some()))
			&& info.s("clear").is_some())
	{
		return None;
	}
	info.setupterm();
	if tgetent {
		info.tgetent();
	}
	Some(info)
}

// ---------------------------------------------------------------------------
// `_nc_trim_sgr0`.

/// ncurses `is_csi`: 1 for an 8-bit CSI, 2 for `ESC [`, else 0.
fn is_csi(s: &[u8]) -> usize {
	if at(s, 0) == 0o233 {
		1
	} else if at(s, 0) == 0o33 && at(s, 1) == b'[' {
		2
	} else {
		0
	}
}

/// ncurses `skip_zero`: past a leading `0;` or a `0` before a letter.
fn skip_zero(s: &[u8], i: usize) -> usize {
	if at(s, i) == b'0' {
		if at(s, i + 1) == b';' {
			return i + 2;
		}
		if at(s, i + 1).is_ascii_alphabetic() {
			return i + 1;
		}
	}
	i
}

/// ncurses `skip_delay`: past a `$<digits/>` delay at `i`.
fn skip_delay(s: &[u8], mut i: usize) -> usize {
	if at(s, i) == b'$' && at(s, i + 1) == b'<' {
		i += 2;
		while at(s, i).is_ascii_digit() || at(s, i) == b'/' {
			i += 1;
		}
		if at(s, i) == b'>' {
			i += 1;
		}
	}
	i
}

/// ncurses `rewrite_sgr`: move `attr` from the front of `s` to its end.
fn rewrite_sgr(s: &mut [u8], attr: Option<&[u8]>) {
	if let Some(attr) = attr
		&& s.len() > attr.len()
		&& s.starts_with(attr)
	{
		s.rotate_left(attr.len());
	}
}

/// ncurses `similar_sgr`.
fn similar_sgr(a: &[u8], b: &[u8]) -> bool {
	let (mut ia, mut ib) = (0, 0);
	let (ca, cb) = (is_csi(a), is_csi(b));
	if ca != 0 && cb != 0 && ca == cb {
		ia += ca;
		ib += cb;
		if at(a, ia) != at(b, ib) {
			ia = skip_zero(a, ia);
			ib = skip_zero(b, ib);
		}
	}
	let (a, b) = (&a[ia.min(a.len())..], &b[ib.min(b.len())..]);
	if a.is_empty() || b.is_empty() {
		return false;
	}
	let n = a.len().min(b.len());
	a[..n] == b[..n]
}

/// ncurses `chop_out`: remove `s[i..j]`.
fn chop_out(s: &mut Vec<u8>, i: usize, j: usize) {
	let tail = s.get(j..).unwrap_or_default().to_vec();
	s.truncate(i.min(s.len()));
	s.extend_from_slice(&tail);
}

/// ncurses `compare_part`: how many bytes of `full` match `part`, delays
/// compared loosely; 0 on a mismatch.
fn compare_part(part: &[u8], full: &[u8]) -> usize {
	let (mut p, mut f) = (0, 0);
	let mut used_full = 0;
	let mut used_delay = 0;
	while at(part, p) != 0 {
		if at(part, p) != at(full, f) {
			used_full = 0;
			break;
		}
		if used_delay != 0 {
			used_full += used_delay;
			used_delay = 0;
		}
		if at(part, p) == b'$' && at(full, f) == b'$' {
			let np = skip_delay(part, p);
			let nf = skip_delay(full, f);
			if np != p && nf != f {
				used_delay += nf - f;
				f = nf;
				p = np;
				continue;
			}
		}
		used_full += 1;
		p += 1;
		f += 1;
	}
	used_full
}

/// ncurses `_nc_trim_sgr0`: `sgr0` without the alternate-charset reset a
/// termcap application cannot undo, derived from `sgr` (`None`: keep
/// `sgr0`).
fn trim_sgr0(
	sgr0: &[u8],
	sgr: &[u8],
	smacs: Option<&[u8]>,
	rmacs: Option<&[u8]>,
) -> Option<Vec<u8>> {
	let p9 = |flag| {
		let mut ps = [TParm::Num(0); 9];
		ps[8] = TParm::Num(flag);
		tparm(sgr, &ps)
	};
	let mut on = p9(1);
	let mut off = p9(0);
	let mut end = sgr0.to_vec();
	rewrite_sgr(&mut on, smacs);
	rewrite_sgr(&mut off, rmacs);
	rewrite_sgr(&mut end, rmacs);
	if !similar_sgr(&off, &end) || similar_sgr(&off, &on) {
		return None;
	}
	let mut found = false;
	let mut result = off.clone();
	if let Some(rmacs) = rmacs {
		let (j, k) = (result.len(), rmacs.len());
		if j > k {
			for i in 0..=(j - k) {
				let k2 = compare_part(rmacs, &result[i..]);
				if k2 != 0 {
					found = true;
					chop_out(&mut result, i, i + k2);
					break;
				}
			}
		}
	}
	// SGR 10 would reset to the normal font.
	if !found {
		let i = is_csi(&result);
		if i != 0 && result.last() == Some(&b'm') {
			let tmp = skip_zero(&result, i);
			if at(&result, tmp) == b'1' && skip_zero(&result, tmp + 1) != tmp + 1 {
				let mut i = tmp;
				if i > 0 && result[i - 1] == b';' {
					i -= 1;
				}
				let j = skip_zero(&result, tmp + 1);
				chop_out(&mut result, i, j);
				found = true;
			}
		}
	}
	if !found
		&& end != result
		&& let Some(i) = end
			.windows(result.len().max(1))
			.position(|w| w == result.as_slice())
		&& !result.is_empty()
	{
		let j = result.len();
		let mut tmp = end.clone();
		chop_out(&mut tmp, i, j);
		result = tmp;
	}
	(result != sgr0).then_some(result)
}

// ---------------------------------------------------------------------------
// tparm (`lib_tparm.c`).

/// A `tparm` parameter: a number, or a string for the `%pN%s` / `%pN%l`
/// parameters (ncurses decides which by scanning the capability; a number
/// where it wants a string is a null pointer, a string where it wants a
/// number is 0).
#[derive(Clone, Copy, Debug)]
pub enum TParm<'a> {
	/// A numeric parameter.
	Num(i32),
	/// A string parameter.
	Str(&'a [u8]),
}

/// `tparm`'s parameter count (`NUM_PARM`).
const NUM_PARM: usize = 9;
/// `tparm`'s stack depth (`STACKSIZE`).
const STACKSIZE: usize = 20;

/// `tparm`'s `%P`/`%g` variables: ncurses keeps both the static (`A`-`Z`)
/// and the dynamic (`a`-`z`) ones across calls.
static VARS: Mutex<([i32; 26], [i32; 26])> = Mutex::new(([0; 26], [0; 26]));

/// A `tparm` stack entry.
#[derive(Clone, Copy, Default)]
struct Item<'a> {
	num_type: bool,
	num:      i32,
	s:        Option<&'a [u8]>,
}

/// The `tparm` stack (over- and underflows are ignored, as in ncurses).
struct Stack<'a> {
	items: [Item<'a>; STACKSIZE],
	ptr:   usize,
}

impl<'a> Stack<'a> {
	const fn npush(&mut self, x: i32) {
		if self.ptr < STACKSIZE {
			self.items[self.ptr] = Item { num_type: true, num: x, s: None };
			self.ptr += 1;
		}
	}

	const fn npop(&mut self) -> i32 {
		if self.ptr > 0 {
			self.ptr -= 1;
			let it = self.items[self.ptr];
			if it.num_type {
				return it.num;
			}
		}
		0
	}

	const fn spush(&mut self, x: Option<&'a [u8]>) {
		if self.ptr < STACKSIZE {
			self.items[self.ptr] = Item { num_type: false, num: 0, s: x };
			self.ptr += 1;
		}
	}

	const fn spop(&mut self) -> &'a [u8] {
		if self.ptr > 0 {
			self.ptr -= 1;
			let it = self.items[self.ptr];
			if !it.num_type
				&& let Some(s) = it.s
			{
				return s;
			}
		}
		b""
	}
}

/// ncurses `parse_format`: the printf format at `%`+`cp` (flags `#`, ` `,
/// `-` after `:`, width, precision, conversion) and the position of the
/// conversion (or of the operator when there is none).
fn parse_format(s: &[u8], mut cp: usize) -> (usize, Vec<u8>) {
	let mut f = vec![b'%'];
	let (mut done, mut allowminus, mut dot, mut err) = (false, false, false, false);
	let mut value: i32 = 0;
	while at(s, cp) != 0 && !done {
		let c = at(s, cp);
		match c {
			b'c' | b'd' | b'o' | b'x' | b'X' | b's' => {
				f.push(c);
				done = true;
			},
			b'.' => {
				f.push(c);
				cp += 1;
				if dot {
					err = true;
				} else {
					dot = true;
				}
				value = 0;
			},
			b'#' | b' ' => {
				f.push(c);
				cp += 1;
			},
			b':' => {
				cp += 1;
				allowminus = true;
			},
			b'-' if allowminus => {
				f.push(c);
				cp += 1;
			},
			_ if c.is_ascii_digit() => {
				value = value.saturating_mul(10).saturating_add(i32::from(c - b'0'));
				if value > 10000 {
					err = true;
				}
				f.push(c);
				cp += 1;
			},
			_ => done = true,
		}
	}
	if err {
		f.truncate(1);
		if at(s, cp) != 0 {
			f.push(at(s, cp));
		}
	}
	(cp, f)
}

/// A parsed C printf conversion.
#[derive(Default)]
struct Spec {
	minus: bool,
	plus:  bool,
	space: bool,
	hash:  bool,
	zero:  bool,
	width: usize,
	prec:  Option<usize>,
	conv:  u8,
}

/// Parse the C format `fmt` (`%` flags width `.`precision conversion).
fn spec(fmt: &[u8]) -> Spec {
	let mut sp = Spec::default();
	let mut i = 1;
	loop {
		match at(fmt, i) {
			b'-' => sp.minus = true,
			b'+' => sp.plus = true,
			b' ' => sp.space = true,
			b'#' => sp.hash = true,
			b'0' => sp.zero = true,
			_ => break,
		}
		i += 1;
	}
	while at(fmt, i).is_ascii_digit() {
		sp.width = sp.width * 10 + usize::from(at(fmt, i) - b'0');
		i += 1;
	}
	if at(fmt, i) == b'.' {
		i += 1;
		let mut p = 0;
		while at(fmt, i).is_ascii_digit() {
			p = p * 10 + usize::from(at(fmt, i) - b'0');
			i += 1;
		}
		sp.prec = Some(p);
	}
	sp.conv = at(fmt, i);
	sp
}

/// Pad `body` (after `prefix`) to the spec's width.
fn pad(sp: &Spec, prefix: &[u8], body: &[u8], zero_ok: bool, out: &mut Vec<u8>) {
	let len = prefix.len() + body.len();
	let fill = sp.width.saturating_sub(len);
	if sp.minus {
		out.extend_from_slice(prefix);
		out.extend_from_slice(body);
		out.resize(out.len() + fill, b' ');
	} else if sp.zero && zero_ok {
		out.extend_from_slice(prefix);
		out.resize(out.len() + fill, b'0');
		out.extend_from_slice(body);
	} else {
		out.resize(out.len() + fill, b' ');
		out.extend_from_slice(prefix);
		out.extend_from_slice(body);
	}
}

/// C `sprintf(fmt, n)` for `%d %o %x %X` formats.
fn printf_num(fmt: &[u8], n: i32, out: &mut Vec<u8>) {
	let sp = spec(fmt);
	let mut digits = match sp.conv {
		b'o' => format!("{:o}", n as u32),
		b'x' => format!("{:x}", n as u32),
		b'X' => format!("{:X}", n as u32),
		_ => n.unsigned_abs().to_string(),
	}
	.into_bytes();
	if let Some(p) = sp.prec {
		if p == 0 && n == 0 {
			digits.clear();
		}
		if digits.len() < p {
			let mut z = vec![b'0'; p - digits.len()];
			z.extend_from_slice(&digits);
			digits = z;
		}
	}
	let mut prefix: Vec<u8> = Vec::new();
	match sp.conv {
		b'o' if sp.hash && digits.first() != Some(&b'0') => digits.insert(0, b'0'),
		b'x' if sp.hash && n != 0 => prefix.extend_from_slice(b"0x"),
		b'X' if sp.hash && n != 0 => prefix.extend_from_slice(b"0X"),
		b'd' | b'i' => {
			if n < 0 {
				prefix.push(b'-');
			} else if sp.plus {
				prefix.push(b'+');
			} else if sp.space {
				prefix.push(b' ');
			}
		},
		_ => {},
	}
	pad(&sp, &prefix, &digits, sp.prec.is_none(), out);
}

/// C `sprintf(fmt, s)` for `%s` formats.
fn printf_str(fmt: &[u8], s: &[u8], out: &mut Vec<u8>) {
	let sp = spec(fmt);
	let s = match sp.prec {
		Some(p) if p < s.len() => &s[..p],
		_ => s,
	};
	pad(&sp, b"", s, false, out);
}

/// ncurses `_nc_tparm_analyze`: how many parameters the string pops
/// (`number`), the highest `%pN` (`popcount`), and which parameters are
/// strings (`%pN` followed by `%s` or `%l`).
fn analyze(s: &[u8]) -> (usize, usize, [bool; NUM_PARM]) {
	let mut p_is_s = [false; NUM_PARM];
	let mut popcount = 0;
	let mut number = 0;
	let mut lastpop: i32 = -1;
	let mut cp = 0;
	while cp < s.len() {
		if s[cp] == b'%' {
			cp = parse_format(s, cp + 1).0;
			match at(s, cp) {
				b'd' | b'o' | b'x' | b'X' | b'c' => {
					if lastpop <= 0 {
						number += 1;
					}
					lastpop = -1;
				},
				b'l' | b's' => {
					if lastpop > 0 {
						p_is_s[(lastpop - 1) as usize] = true;
					}
					number += 1;
				},
				b'p' => {
					cp += 1;
					let i = i32::from(at(s, cp)) - i32::from(b'0');
					if (0..=NUM_PARM as i32).contains(&i) {
						lastpop = i;
						popcount = popcount.max(i as usize);
					}
				},
				b'P' => {
					number += 1;
					cp += 1;
				},
				b'g' => cp += 1,
				b'\'' => {
					cp += 2;
					lastpop = -1;
				},
				b'{' => {
					cp += 1;
					while at(s, cp).is_ascii_digit() {
						cp += 1;
					}
				},
				b'+' | b'-' | b'*' | b'/' | b'm' | b'A' | b'O' | b'&' | b'|' | b'^' | b'=' | b'<'
				| b'>' => {
					lastpop = -1;
					number += 2;
				},
				b'!' | b'~' => {
					lastpop = -1;
					number += 1;
				},
				_ => {},
			}
		}
		if at(s, cp) != 0 {
			cp += 1;
		}
	}
	(number.min(NUM_PARM), popcount.min(NUM_PARM), p_is_s)
}

/// Skip a false `%?` branch (`%t` with `else_too`) or the rest of a true
/// one (`%e`): to the matching `%e` / `%;` at level zero.
fn skip_branch(s: &[u8], mut cp: usize, stop_at_else: bool) -> usize {
	cp += 1;
	let mut level = 0;
	while at(s, cp) != 0 {
		if s[cp] == b'%' {
			cp += 1;
			match at(s, cp) {
				b'?' => level += 1,
				b';' => {
					if level > 0 {
						level -= 1;
					} else {
						break;
					}
				},
				b'e' if stop_at_else && level == 0 => break,
				_ => {},
			}
		}
		if at(s, cp) != 0 {
			cp += 1;
		}
	}
	cp
}

/// ncurses `tparm`: instantiate the parameterized capability `cap` with
/// `params` (missing ones are 0).
pub fn tparm(cap: &[u8], params: &[TParm<'_>]) -> Vec<u8> {
	let s = cstr(cap);
	let (number, popcount, p_is_s) = analyze(s);
	let num_args = popcount.max(number);
	let mut param = [0i32; NUM_PARM];
	let mut sparam: [Option<&[u8]>; NUM_PARM] = [None; NUM_PARM];
	for i in 0..num_args {
		if p_is_s[i] {
			sparam[i] = match params.get(i) {
				Some(TParm::Str(x)) => Some(cstr(x)),
				_ => None,
			};
		} else {
			param[i] = match params.get(i) {
				Some(TParm::Num(n)) => *n,
				_ => 0,
			};
		}
	}
	let mut st = Stack { items: [Item::default(); STACKSIZE], ptr: 0 };
	// The termcap hack: no `%pN`, so the parameters are pushed for
	// successive pops.
	let termcap_hack = popcount == 0;
	if termcap_hack {
		for i in (0..number).rev() {
			match sparam[i] {
				Some(x) => st.spush(Some(x)),
				None => st.npush(param[i]),
			}
		}
	}
	let mut vars = VARS.lock().unwrap_or_else(PoisonError::into_inner);
	let mut out = Vec::with_capacity(s.len() + 16);
	let save_char = |out: &mut Vec<u8>, c: i32| out.push(if c == 0 { 0o200 } else { c as u8 });
	let mut incremented_two = false;
	let mut cp = 0;
	while cp < s.len() {
		if s[cp] == b'%' {
			let (ncp, fmt) = parse_format(s, cp + 1);
			cp = ncp;
			match at(s, cp) {
				b'%' => out.push(b'%'),
				b'd' | b'o' | b'x' | b'X' => {
					let n = st.npop();
					printf_num(&fmt, n, &mut out);
				},
				b'c' => {
					let n = st.npop();
					save_char(&mut out, n);
				},
				b'l' => {
					let n = st.spop().len();
					st.npush(i32::try_from(n).unwrap_or(i32::MAX));
				},
				b's' => {
					let x = st.spop();
					printf_str(&fmt, x, &mut out);
				},
				b'p' => {
					cp += 1;
					let i = i32::from(at(s, cp)) - i32::from(b'1');
					if (0..NUM_PARM as i32).contains(&i) {
						let i = i as usize;
						match sparam[i] {
							Some(x) => st.spush(Some(x)),
							None => st.npush(param[i]),
						}
					}
				},
				b'P' => {
					cp += 1;
					let c = at(s, cp);
					if c.is_ascii_uppercase() {
						vars.0[usize::from(c - b'A')] = st.npop();
					} else if c.is_ascii_lowercase() {
						vars.1[usize::from(c - b'a')] = st.npop();
					}
				},
				b'g' => {
					cp += 1;
					let c = at(s, cp);
					if c.is_ascii_uppercase() {
						st.npush(vars.0[usize::from(c - b'A')]);
					} else if c.is_ascii_lowercase() {
						st.npush(vars.1[usize::from(c - b'a')]);
					}
				},
				b'\'' => {
					cp += 1;
					st.npush(i32::from(at(s, cp)));
					cp += 1;
				},
				b'{' => {
					let mut n: i32 = 0;
					cp += 1;
					while at(s, cp).is_ascii_digit() {
						n = n.wrapping_mul(10).wrapping_add(i32::from(at(s, cp) - b'0'));
						cp += 1;
					}
					st.npush(n);
				},
				b'+' => {
					let v = st.npop().wrapping_add(st.npop());
					st.npush(v);
				},
				b'-' => {
					let y = st.npop();
					let x = st.npop();
					st.npush(x.wrapping_sub(y));
				},
				b'*' => {
					let v = st.npop().wrapping_mul(st.npop());
					st.npush(v);
				},
				b'/' => {
					let y = st.npop();
					let x = st.npop();
					st.npush(if y != 0 { x.wrapping_div(y) } else { 0 });
				},
				b'm' => {
					let y = st.npop();
					let x = st.npop();
					st.npush(if y != 0 { x.wrapping_rem(y) } else { 0 });
				},
				b'A' => {
					let y = st.npop();
					let x = st.npop();
					st.npush(i32::from(y != 0 && x != 0));
				},
				b'O' => {
					let y = st.npop();
					let x = st.npop();
					st.npush(i32::from(y != 0 || x != 0));
				},
				b'&' => {
					let v = st.npop() & st.npop();
					st.npush(v);
				},
				b'|' => {
					let v = st.npop() | st.npop();
					st.npush(v);
				},
				b'^' => {
					let v = st.npop() ^ st.npop();
					st.npush(v);
				},
				b'=' => {
					let y = st.npop();
					let x = st.npop();
					st.npush(i32::from(x == y));
				},
				b'<' => {
					let y = st.npop();
					let x = st.npop();
					st.npush(i32::from(x < y));
				},
				b'>' => {
					let y = st.npop();
					let x = st.npop();
					st.npush(i32::from(x > y));
				},
				b'!' => {
					let v = st.npop();
					st.npush(i32::from(v == 0));
				},
				b'~' => {
					let v = st.npop();
					st.npush(!v);
				},
				b'i' => {
					// Add 1 to the first two numeric parameters (and, with
					// the termcap hack, to the bottom of the stack).
					if !incremented_two {
						incremented_two = true;
						for k in 0..2 {
							if sparam[k].is_none() {
								param[k] = param[k].wrapping_add(1);
								if termcap_hack {
									st.items[k].num = param[k];
								}
							}
						}
					}
				},
				b't' => {
					if st.npop() == 0 {
						cp = skip_branch(s, cp, true);
					}
				},
				b'e' => cp = skip_branch(s, cp, false),
				_ => {},
			}
		} else {
			out.push(s[cp]);
		}
		if at(s, cp) == 0 {
			break;
		}
		cp += 1;
	}
	out
}

// ---------------------------------------------------------------------------
// tgoto, tputs.

/// ncurses `is_termcap`: a string without `%p` and `$<` delays is a
/// termcap-style `cm`.
fn is_termcap(s: &[u8]) -> bool {
	if s.is_empty() {
		return false;
	}
	let mut i = 0;
	while i < s.len() {
		if s[i] == b'%' {
			i += 1;
			match at(s, i) {
				b'p' => return false,
				0 => i -= 1,
				_ => {},
			}
		} else if s[i] == b'$' && at(s, i + 1) == b'<' {
			return false;
		}
		i += 1;
	}
	true
}

/// ncurses `tgoto(cap, col, row)` without a `BC` string: see
/// [`tgoto_bc`].
pub fn tgoto(cap: &[u8], col: i32, row: i32) -> Vec<u8> {
	tgoto_bc(cap, col, row, None)
}

/// ncurses `tgoto(cap, col, row)`: a termcap-style string (`%d %2 %3 %.
/// %+c %> %r %i %n %B %D`) is expanded by termcap rules, where a NUL
/// character is avoided by adding 1 and appending `bc` (the entry's
/// [`TermInfo::bc`]) when there is one; a terminfo string goes through
/// [`tparm`] with `row, col`.
pub fn tgoto_bc(cap: &[u8], col: i32, row: i32, bc: Option<&[u8]>) -> Vec<u8> {
	let s = cstr(cap);
	if !is_termcap(s) {
		return tparm(s, &[TParm::Num(row), TParm::Num(col)]);
	}
	let mut param = [row, col, 0];
	let mut v = 0;
	let mut need_bc = false;
	let mut out = Vec::with_capacity(s.len() + 10);
	let mut i = 0;
	while i < s.len() {
		if s[i] == b'%' {
			i += 1;
			let mut fmt: Option<usize> = None;
			match at(s, i) {
				0 => i -= 1,
				b'd' => fmt = Some(1),
				b'2' => {
					fmt = Some(2);
					param[v] %= 100;
				},
				b'3' => {
					fmt = Some(3);
					param[v] %= 1000;
				},
				c @ (b'+' | b'.') => {
					if c == b'+' {
						i += 1;
						param[v] = param[v].wrapping_add(i32::from(at(s, i)));
					}
					if param[v] == 0 {
						if bc.is_some() {
							param[v] += 1;
							need_bc = true;
						} else {
							param[v] = 0o200;
						}
					}
					out.push(param[v] as u8);
					v += 1;
				},
				b'%' => out.push(b'%'),
				b'r' => param.swap(0, 1),
				b'i' => {
					param[0] = param[0].wrapping_add(1);
					param[1] = param[1].wrapping_add(1);
				},
				b'>' => {
					// `char` compares signed on the reference host.
					if param[v] > i32::from(at(s, i + 1) as i8) {
						param[v] = param[v].wrapping_add(i32::from(at(s, i + 2) as i8));
					}
					i += 2;
				},
				b'n' => {
					param[0] ^= 0o140;
					param[1] ^= 0o140;
				},
				b'B' => param[v] = 16 * (param[v] / 10) + param[v] % 10,
				b'D' => param[v] -= 2 * (param[v] % 16),
				_ => {},
			}
			if let Some(w) = fmt {
				let n = param[v];
				let text = match w {
					2 => format!("{n:02}"),
					3 => format!("{n:03}"),
					_ => n.to_string(),
				};
				out.extend_from_slice(text.as_bytes());
				v += 1;
			}
			if v > 2 {
				v = 2;
				param[2] = 0;
			}
		} else {
			out.push(s[i]);
		}
		i += 1;
	}
	if need_bc && let Some(bc) = bc {
		out.extend_from_slice(cstr(bc));
	}
	out
}

/// ncurses `tputs(cap)` as zsh's output sees it: the string with `$<n>`
/// padding specifications removed (no padding characters or delays: the
/// output speed of a pipe or pty is 0 to ncurses' padding).
pub fn tputs(cap: &[u8]) -> Vec<u8> {
	let s = cstr(cap);
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		if s[i] == b'$' {
			i += 1;
			if at(s, i) == b'<' {
				i += 1;
				let c = at(s, i);
				if (!c.is_ascii_digit() && c != b'.') || !s[i..].contains(&b'>') {
					out.push(b'$');
					out.push(b'<');
					continue;
				}
				while at(s, i).is_ascii_digit() {
					i += 1;
				}
				if at(s, i) == b'.' {
					i += 1;
					while at(s, i).is_ascii_digit() {
						i += 1;
					}
				}
				while matches!(at(s, i), b'*' | b'/') {
					i += 1;
				}
			} else {
				out.push(b'$');
				if at(s, i) != 0 {
					out.push(s[i]);
				}
			}
		} else {
			out.push(s[i]);
		}
		if at(s, i) == 0 {
			break;
		}
		i += 1;
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	const SETAF: &[u8] = b"\x1b[%?%p1%{8}%<%t3%p1%d%e%p1%{16}%<%t9%p1%{8}%-%d%e38;5;%p1%d%;m";
	const SGR: &[u8] = b"%?%p9%t\x1b(0%e\x1b(B%;\x1b[0%?%p6%t;1%;%?%p5%t;2%;%?%p2%t;4%;%?%p1%p3%|%t;7%;%?%p4%t;5%;%?%p7%t;8%;m";

	/// Without a database (Windows) ZLE had no cursor motion and left every
	/// edit on screen: the embedded entry must parse with what it needs.
	#[test]
	fn embedded_console_entry_has_cursor_motion() {
		let info = parse(WINDOWS_CONSOLE_ENTRY).expect("parses");
		assert_eq!(info.s("cub1"), Some(&b"\x08"[..]));
		assert!(info.s("cup").is_some() && info.s("el").is_some());
	}

	#[test]
	fn tparm_xterm_caps() {
		let cup = b"\x1b[%i%p1%d;%p2%dH";
		assert_eq!(tparm(cup, &[TParm::Num(5), TParm::Num(10)]), b"\x1b[6;11H");
		assert_eq!(tparm(cup, &[TParm::Num(1)]), b"\x1b[2;1H");
		assert_eq!(tparm(SETAF, &[TParm::Num(1)]), b"\x1b[31m");
		assert_eq!(tparm(SETAF, &[TParm::Num(9)]), b"\x1b[91m");
		assert_eq!(tparm(SETAF, &[TParm::Num(300)]), b"\x1b[38;5;300m");
		let ms = b"\x1b]52;%p1%s;%p2%s\x07";
		assert_eq!(tparm(ms, &[TParm::Num(0), TParm::Num(0)]), b"\x1b]52;;\x07");
		assert_eq!(tparm(ms, &[TParm::Str(b"c"), TParm::Str(b"eA==")]), b"\x1b]52;c;eA==\x07");
	}

	#[test]
	fn tparm_formats_and_ops() {
		assert_eq!(
			tparm(b"%p1%02d|%p1%:-4d|%p1%#x|%p1%X|%p1%o", &[TParm::Num(10)]),
			b"10|10  |0xa|A|12"
		);
		assert_eq!(tparm(b"%'a'%c%{66}%c%p1%c", &[TParm::Num(0)]), b"aB\x80");
		assert_eq!(
			tparm(b"%p1%p2%m%d %p1%p2%/%d %p1%!%d %p1%~%d", &[TParm::Num(7), TParm::Num(3)]),
			b"1 2 0 -8"
		);
		assert_eq!(tparm(b"%p1%Pa%ga%ga%+%d", &[TParm::Num(4)]), b"8");
		assert_eq!(tparm(b"%?%p1%t1%e%p2%t2%e3%;", &[TParm::Num(0), TParm::Num(1)]), b"2");
		assert_eq!(tparm(b"%?%p1%t1%e%p2%t2%e3%;", &[TParm::Num(0), TParm::Num(0)]), b"3");
		assert_eq!(tparm(b"%p1%l%d", &[TParm::Str(b"abc")]), b"3");
		assert_eq!(tparm(b"%p1%s%p1%l%d", &[TParm::Str(b"abc")]), b"abc3");
		// The termcap hack: no `%p`, the parameters are pre-pushed.
		assert_eq!(tparm(b"\x1b[%d;%dH", &[TParm::Num(3), TParm::Num(4)]), b"\x1b[3;4H");
	}

	#[test]
	fn tgoto_styles() {
		assert_eq!(tgoto(b"\x1b[%i%p1%d;%p2%dH", 4, 3), b"\x1b[4;5H");
		assert_eq!(tgoto(b"\x1b[%i%d;%dH", 4, 3), b"\x1b[4;5H");
		assert_eq!(tgoto(b"\x1b=%+ %+ ", 4, 3), b"\x1b=#$");
		assert_eq!(tgoto(b"%r%2,%3", 4, 3), b"04,003");
		assert_eq!(tgoto_bc(b"%.", 0, 0, Some(b"\x1bD")), b"\x01\x1bD");
		assert_eq!(tgoto(b"%.", 0, 0), b"\x80");
	}

	#[test]
	fn tputs_strips_padding() {
		assert_eq!(tputs(b"\x1b[?5h$<100/>\x1b[?5l"), b"\x1b[?5h\x1b[?5l");
		assert_eq!(tputs(b"a$<5*>b$<2.5>c"), b"abc");
		assert_eq!(tputs(b"$x$<y>$<1"), b"$x$<y>$<1");
	}

	#[test]
	fn trim_sgr0_xterm() {
		let fix = trim_sgr0(b"\x1b(B\x1b[m", SGR, Some(b"\x1b(0"), Some(b"\x1b(B"));
		assert_eq!(fix.as_deref(), Some(&b"\x1b[0m"[..]));
	}

	#[test]
	fn tables_have_ncurses_sizes() {
		assert_eq!(bool_names().count(), BOOLCOUNT);
		assert_eq!(bool_codes().count(), BOOLCOUNT);
		assert_eq!(num_names().count(), NUMCOUNT);
		assert_eq!(num_codes().count(), NUMCOUNT);
		assert_eq!(str_names().count(), STRCOUNT);
		assert_eq!(str_codes().count(), STRCOUNT);
	}

	/// A legacy compiled entry: names, `am`, `cols#80`, `cub1=^H`,
	/// `sgr0`, then the extended `AX` and `Ms`.
	fn entry() -> Vec<u8> {
		let mut b = Vec::new();
		let short = |b: &mut Vec<u8>, v: i16| b.extend_from_slice(&v.to_le_bytes());
		let names = b"t1|test\0";
		let table = b"\x08\0\x1b[m\0";
		for v in [MAGIC as i16, names.len() as i16, 2, 1, 40, table.len() as i16] {
			short(&mut b, v);
		}
		b.extend_from_slice(names);
		b.extend_from_slice(&[0, 1]);
		short(&mut b, 80);
		let mut offs = [-1i16; 40];
		offs[14] = 0; // cub1
		offs[39] = 2; // sgr0
		for o in offs {
			short(&mut b, o);
		}
		b.extend_from_slice(table);
		// Extended: 1 bool, 0 nums, 1 string.
		let ext_table = b"\x1b]52;%p1%s\x07\0AX\0Ms\0";
		for v in [1, 0, 1, 3, ext_table.len() as i16] {
			short(&mut b, v);
		}
		b.push(1);
		b.push(0);
		for o in [0i16, 0, 3] {
			short(&mut b, o);
		}
		b.extend_from_slice(ext_table);
		b
	}

	#[test]
	fn parses_legacy_entry_with_extensions() {
		let mut ti = parse(&entry()).expect("entry parses");
		ti.setupterm();
		ti.tgetent();
		assert!(ti.flag("am"));
		assert!(!ti.flag("bw"));
		assert_eq!(ti.flag_known("AX"), Some(true));
		assert_eq!(ti.flag_known("nope"), None);
		assert_eq!(ti.num("cols"), Some(80));
		assert_eq!(ti.num("lines"), Some(24));
		assert_eq!(ti.tc_num("co"), Some(80));
		assert_eq!(ti.str("Ms"), Some(&b"\x1b]52;%p1%s\x07"[..]));
		assert_eq!(ti.tc_str("Ms").as_deref(), Some(&b"\x1b]52;%p1%s\x07"[..]));
		assert!(ti.tc_flag("AX"));
		assert!(ti.tc_flag("bs"));
		assert_eq!(ti.tc_str("bc"), None);
		assert_eq!(ti.tc_str("me").as_deref(), Some(&b"\x1b[m"[..]));
	}
}
