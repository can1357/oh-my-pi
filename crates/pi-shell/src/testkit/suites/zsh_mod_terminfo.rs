//! zsh/terminfo and zsh/termcap: `echoti`, `echotc`, `$terminfo`,
//! `$termcap` over the host's terminfo database (`xterm-256color`, `dumb`,
//! `vt52`, `4410-w` from the system directory; the test shell exports no
//! `TERMINFO`, `HOME`, nor `TERM` unless a test sets it). Expected output
//! comes from `/bin/zsh -f -c` 5.9 run
//! with `env -i PATH=/usr/bin:/bin`.

use bstr::BString;

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src`: stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// `echoti` prints numbers, `yes`/`no` and strings, instantiating parameters
/// with `tparm` (`cup`, `setaf`, string parameters of `Ms`), padding stripped
/// (`flash`), extended capabilities included.
#[test]
fn echoti_xterm_values() {
	let (out, err, status) = zsh(
		"TERM=xterm-256color; echoti colors; echoti cup 5 10; echoti bold; echoti sgr0; echoti am; \
		 echoti bw; echoti Ms a b; echoti setaf 196; echoti flash; echoti AX; echoti kUP5",
	);
	assert_eq!(
		out,
		concat!(
			"256\n",
			"\x1b[6;11H\x1b[1m\x1b(B\x1b[myes\n",
			"no\n",
			"\x1b]52;;\x07\x1b[38;5;196m\x1b[?5h\x1b[?5lyes\n",
			"\x1b[1;5A",
		)
	);
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// Elements of `terminfo`/`termcap`: integers, booleans, raw strings, termcap
/// `me` trimmed of the charset reset (`_nc_trim_sgr0`), extended names, unset
/// for unknown names.
#[test]
fn terminfo_termcap_elements() {
	let (out, err, status) = zsh(
		"TERM=xterm-256color; print -r -- ${terminfo[colors]} ${termcap[Co]} ${termcap[co]} \
		 ${terminfo[cols]} ${terminfo[lines]}; print -r -- ${(q)terminfo[cup]} ${(q)termcap[me]} \
		 ${(q)terminfo[sgr0]} ${(q)termcap[cm]}; print -r -- ${terminfo[AX]} ${(q)terminfo[Ms]} \
		 ${+terminfo[foo]} ${+terminfo[bw]} ${terminfo[bw]} ${+termcap[bc]} ${termcap[bs]}; print \
		 -r -- ${(t)terminfo} ${(t)termcap}",
	);
	assert_eq!(
		out,
		"256 256 80 80 24\n$'\\033'\\[%i%p1%d\\;%p2%dH $'\\033'\\[0m $'\\033'\\(B$'\\033'\\[m \
		 $'\\033'\\[%i%p1%d\\;%p2%dH\nyes $'\\033'\\]52\\;%p1%s\\;%p2%s$'\\a' 0 1 no 0 \
		 yes\nassociation-readonly-hide-hideval-special association-readonly-hide-hideval-special\n"
	);
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// `echotc`: `cm` through `tgoto` (row, column), `me` trimmed, `bs` from
/// `cub1`, two-letter extended names.
#[test]
fn echotc_xterm_values() {
	let (out, err, status) = zsh(
		"TERM=xterm-256color; echotc cm 3 4; echotc me; echotc bs; echotc AX; echotc Co; echotc le; \
		 echotc Ms; echo $?",
	);
	assert_eq!(out, "\x1b[4;5H\x1b[0myes\nyes\n256\n\x08\x1b]52;%p1%s;%p2%s\x070\n");
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// Unknown capabilities and wrong argument counts.
#[test]
fn capability_errors() {
	let (out, err, status) = zsh(
		"TERM=xterm-256color; echoti foo; echo $?; echoti cup 1 2 3 4 5 6 7 8 9 10; echo $?; echotc \
		 foo; echo $?; echotc cm 1; echo $?; echotc cm 1 2 3; echo $?; echotc bc; echo $?",
	);
	assert_eq!(out, "1\n1\n1\n1\n1\n1\n");
	assert_eq!(
		err,
		"zsh:echoti:1: no such terminfo capability: foo\nzsh:echoti:1: too many \
		 arguments\nzsh:echotc:1: no such capability: foo\nzsh:echotc:1: not enough \
		 arguments\nzsh:echotc:1: too many arguments\nzsh:echotc:1: no such capability: bc\n"
	);
	assert_eq!(status, 0);
}

/// zsh/terminfo and zsh/termcap load when their builtin or parameter is first
/// used.
#[test]
fn modules_autoload_on_use() {
	let (out, err, status) = zsh(
		"zmodload -e zsh/terminfo; echo $?; TERM=xterm-256color; echoti colors; zmodload -e \
		 zsh/terminfo; echo $?; zmodload -e zsh/termcap; echo $?; print $termcap[Co]; zmodload -e \
		 zsh/termcap; echo $?",
	);
	assert_eq!(out, "1\n256\n0\n1\n256\n0\n");
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// `${(k)terminfo}` lists the terminal ncurses holds (none before `$TERM` was
/// first set up; the old one after a bad `TERM`), in ncurses' order.
#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "expects macOS's terminfo database")]
fn scans_list_the_held_terminal() {
	let (out, err, status) = zsh(
		"TERM=xterm-256color; print -r -- ${#terminfo} ${(k)termcap}; echoti cols >/dev/null; print \
		 -r -- ${(k)terminfo}; print -r -- ${(k)termcap}; print -r -- ${(kv)terminfo[(I)co*]}; \
		 print -r -- ${#terminfo} ${#termcap}; TERM=nosuch; echoti colors; echo $?; print -r -- \
		 ${#terminfo} ${+terminfo[cols]}",
	);
	assert_eq!(
		out,
		"0 bw am xb xs xn eo gn hc km hs in da db mi ms os es xt hz ul xo nx 5i HC NR NP ND cc ut \
		 hl YA YB YC YD YE YF YG bs ns nc MT NL pt xr\nbw am xsb xhp xenl eo gn hc km hs in da db \
		 mir msgr os eslok xt hz ul xon nxon mc5i chts nrrmc npc ndscr ccc bce hls xhpa crxm daisy \
		 xvpa sam cpix lpix OTbs OTns OTnc OTMT OTNL OTpt OTxr cols it lines colors pairs cbt bel \
		 cr csr tbc clear el ed hpa cup cud1 home civis cub1 cnorm cuf1 cuu1 cvvis dch1 dl1 smacs \
		 blink bold smcup dim smir invis rev smso smul ech rmacs sgr0 rmcup rmir rmso rmul flash \
		 is2 il1 kbs kdch1 kcud1 kf1 kf10 kf2 kf3 kf4 kf5 kf6 kf7 kf8 kf9 khome kich1 kcub1 knp kpp \
		 kcuf1 kind kri kcuu1 rmkx smkx rmm smm dch dl cud ich indn il cub cuf rin cuu mc0 mc4 mc5 \
		 rs1 rs2 rc vpa sc ind ri sgr hts ht kb2 acsc kcbt smam rmam kend kent kDC kEND kHOM kIC \
		 kLFT kNXT kPRV kRIT kf11 kf12 kf13 kf14 kf15 kf16 kf17 kf18 kf19 kf20 kf21 kf22 kf23 kf24 \
		 kf25 kf26 kf27 kf28 kf29 kf30 kf31 kf32 kf33 kf34 kf35 kf36 kf37 kf38 kf39 kf40 kf41 kf42 \
		 kf43 kf44 kf45 kf46 kf47 kf48 kf49 kf50 kf51 kf52 kf53 kf54 kf55 kf56 kf57 kf58 kf59 kf60 \
		 kf61 kf62 kf63 el1 u6 u7 u8 u9 op initc sitm ritm kmous setaf setab meml memu\nbw am xb xs \
		 xn eo gn hc km hs in da db mi ms os es xt hz ul xo nx 5i HC NR NP ND cc ut hl YA YB YC YD \
		 YE YF YG bs ns nc MT NL pt xr co it li Co pa bt bl cr cs ct cl ce cd ch cm do ho vi le ve \
		 nd up vs dc dl as mb md ti mh im mk mr so us ec ae me te ei se ue vb is al kb kD kd k1 k; \
		 k2 k3 k4 k5 k6 k7 k8 k9 kh kI kl kN kP kr kF kR ku ke ks mo mm DC DL DO IC SF AL LE RI SR \
		 UP ps pf po r1 r2 rc cv sc sf sr sa st ta K2 ac kB SA RA @7 @8 *4 *7 #2 #3 #4 %c %e %i F1 \
		 F2 F3 F4 F5 F6 F7 F8 F9 FA FB FC FD FE FF FG FH FI FJ FK FL FM FN FO FP FQ FR FS FT FU FV \
		 FW FX FY FZ Fa Fb Fc Fd Fe Ff Fg Fh Fi Fj Fk Fl Fm Fn Fo Fp Fq Fr cb u6 u7 u8 u9 op Ic ZH \
		 ZR Km AF AB ml mu\ncols 80 colors 256\n220 220\n1\n220 0\n"
	);
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// `TERM=dumb`: no `cup`, no `colors`; the screen size fallback (`lines` 24).
#[test]
fn dumb_terminal() {
	let (out, err, status) = zsh(
		"TERM=dumb; echoti cup 1 2; echo $?; echoti colors; echo $?; echotc co; echo $?; print -r \
		 -- ${(kv)terminfo[(I)co*]}; print -r -- ${#terminfo} ${#termcap} ${+terminfo[colors]} \
		 ${+terminfo[bw]}; print -r -- ${(qqqq)${(kv)terminfo}}; print -r -- ${(qqqq)${(kv)termcap}}",
	);
	assert_eq!(
		out,
		"1\n1\n80\n0\ncols 80\n50 50 0 1\n$'bw' $'no' $'am' $'yes' $'xsb' $'no' $'xhp' $'no' \
		 $'xenl' $'no' $'eo' $'no' $'gn' $'no' $'hc' $'no' $'km' $'no' $'hs' $'no' $'in' $'no' \
		 $'da' $'no' $'db' $'no' $'mir' $'no' $'msgr' $'no' $'os' $'no' $'eslok' $'no' $'xt' $'no' \
		 $'hz' $'no' $'ul' $'no' $'xon' $'no' $'nxon' $'no' $'mc5i' $'no' $'chts' $'no' $'nrrmc' \
		 $'no' $'npc' $'no' $'ndscr' $'no' $'ccc' $'no' $'bce' $'no' $'hls' $'no' $'xhpa' $'no' \
		 $'crxm' $'no' $'daisy' $'no' $'xvpa' $'no' $'sam' $'no' $'cpix' $'no' $'lpix' $'no' \
		 $'OTbs' $'no' $'OTns' $'no' $'OTnc' $'no' $'OTMT' $'no' $'OTNL' $'no' $'OTpt' $'no' \
		 $'OTxr' $'no' $'cols' $'80' $'lines' $'24' $'bel' $'\\a' $'cr' $'\\r' $'cud1' $'\\n' \
		 $'ind' $'\\n'\n$'bw' $'no' $'am' $'yes' $'xb' $'no' $'xs' $'no' $'xn' $'no' $'eo' $'no' \
		 $'gn' $'no' $'hc' $'no' $'km' $'no' $'hs' $'no' $'in' $'no' $'da' $'no' $'db' $'no' $'mi' \
		 $'no' $'ms' $'no' $'os' $'no' $'es' $'no' $'xt' $'no' $'hz' $'no' $'ul' $'no' $'xo' $'no' \
		 $'nx' $'no' $'5i' $'no' $'HC' $'no' $'NR' $'no' $'NP' $'no' $'ND' $'no' $'cc' $'no' $'ut' \
		 $'no' $'hl' $'no' $'YA' $'no' $'YB' $'no' $'YC' $'no' $'YD' $'no' $'YE' $'no' $'YF' $'no' \
		 $'YG' $'no' $'bs' $'no' $'ns' $'no' $'nc' $'no' $'MT' $'no' $'NL' $'no' $'pt' $'no' $'xr' \
		 $'no' $'co' $'80' $'li' $'24' $'bl' $'\\a' $'cr' $'\\r' $'do' $'\\n' $'sf' $'\\n'\n"
	);
	assert_eq!(
		err,
		"zsh:echoti:1: no such terminfo capability: cup\nzsh:echoti:1: no such terminfo capability: \
		 colors\n"
	);
	assert_eq!(status, 0);
}

/// No `TERM`, or one without a description: the builtins fail silently,
/// `termcap` still lists every boolean code as unset.
#[test]
fn unknown_or_unset_term() {
	let (out, err, status) = zsh(
		"echoti colors; echo $?; echotc am; echo $?; print -r -- ${#terminfo} ${#termcap} \
		 ${+termcap[bw]}; TERM=nosuchterm; echoti colors; echo $?; echotc co; echo $?; print -r -- \
		 ${#terminfo} ${(kv)termcap}",
	);
	assert_eq!(
		out,
		"1\n1\n0 44 0\n1\n1\n0 bw no am no xb no xs no xn no eo no gn no hc no km no hs no in no da \
		 no db no mi no ms no os no es no xt no hz no ul no xo no nx no 5i no HC no NR no NP no ND \
		 no cc no ut no hl no YA no YB no YC no YD no YE no YF no YG no bs no ns no nc no MT no NL \
		 no pt no xr no\n"
	);
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// Run `src` as `zsh -c src` with `TERM=term` in the environment.
fn zsh_term(src: &str, term: &str) -> (String, String, i32) {
	let mut init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	init.env.push((BString::from("TERM"), BString::from(term)));
	let mut rig = Rig::new(FakeHost::new(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// With `TERM` exported, the module's boot has ncurses `setupterm` it: listings
/// show the raw `sgr0` as `me` until `tgetent` (here `echotc`) trims it; a
/// failed `tgetent` clears the trim again.
#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "expects macOS's terminfo database")]
fn held_terminal_from_boot_is_set_up_without_tgetent() {
	let (out, err, status) = zsh_term(
		"for k v in ${(kv)termcap}; do [[ $k == (me|bc|bs|le) ]] && print -r -- \"$k=${(q)v}\"; \
		 done; print -r -- \"<\"${(M)${(k)terminfo}:#OT(bc|i2|rs)}\">\" ${#terminfo}; echotc co; \
		 for k v in ${(kv)termcap}; do [[ $k == (me|bc|bs|le) ]] && print -r -- \"$k=${(q)v}\"; \
		 done; print -r -- \"<\"${(M)${(k)terminfo}:#OT(bc|i2|rs)}\">\" ${#terminfo}; TERM=nosuch; \
		 echotc co; echo $?; for k v in ${(kv)termcap}; do [[ $k == (me|bc|bs|le) ]] && print -r -- \
		 \"$k=${(q)v}\"; done; print -r -- \"<\"${(M)${(k)terminfo}:#OT(bc|i2|rs)}\">\" ${#terminfo}",
		"xterm-256color",
	);
	assert_eq!(
		out,
		"bs=yes\nle=$'\\b'\nme=$'\\033'\\(B$'\\033'\\[m\n<> \
		 220\n80\nbs=yes\nle=$'\\b'\nme=$'\\033'\\[0m\n<> \
		 220\n1\nbs=yes\nle=$'\\b'\nme=$'\\033'\\(B$'\\033'\\[m\n<> 220\n"
	);
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// `tgetent` turns `cub1` into `OTbs`/`OTbc` (`bs`, `bc`) of the held terminal.
#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "expects macOS's terminfo database")]
fn tgetent_adjusts_the_held_terminal() {
	let (out, err, status) = zsh_term(
		"for k v in ${(kv)termcap}; do [[ $k == (me|bc|bs|le) ]] && print -r -- \"$k=${(q)v}\"; \
		 done; print -r -- \"<\"${(M)${(k)terminfo}:#OT(bc|i2|rs)}\">\" ${#terminfo}; print -r -- \
		 ${(q)terminfo[OTbc]}; for k v in ${(kv)termcap}; do [[ $k == (me|bc|bs|le) ]] && print -r \
		 -- \"$k=${(q)v}\"; done; print -r -- \"<\"${(M)${(k)terminfo}:#OT(bc|i2|rs)}\">\" \
		 ${#terminfo}",
		"vt52",
	);
	assert_eq!(
		out,
		"bs=yes\nle=$'\\033'D\n<> 70\n$'\\033'D\nbs=no\nle=$'\\033'D\nbc=$'\\033'D\n<OTbc> 71\n"
	);
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// zsh/termcap booting first sets the terminal up the same way.
#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "expects macOS's terminfo database")]
fn termcap_module_boots_first() {
	let (out, err, status) = zsh_term(
		"print -r -- ${#termcap}; for k v in ${(kv)termcap}; do [[ $k == (me|bc|bs|le) ]] && print \
		 -r -- \"$k=${(q)v}\"; done; print -r -- \"<\"${(M)${(k)terminfo}:#OT(bc|i2|rs)}\">\" \
		 ${#terminfo}; print -r -- ${(q)termcap[le]} ${#termcap}; for k v in ${(kv)termcap}; do [[ \
		 $k == (me|bc|bs|le) ]] && print -r -- \"$k=${(q)v}\"; done; print -r -- \
		 \"<\"${(M)${(k)terminfo}:#OT(bc|i2|rs)}\">\" ${#terminfo}",
		"vt52",
	);
	assert_eq!(
		out,
		"70\nbs=yes\nle=$'\\033'D\n<> 70\n$'\\033'D 71\nbs=no\nle=$'\\033'D\nbc=$'\\033'D\n<OTbc> \
		 71\n"
	);
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// The exported `TERM` at boot is the one set up; a later `tgetent` of the same
/// name adjusts it.
#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "expects macOS's terminfo database")]
fn another_term_replaces_the_boot_one() {
	let (out, err, status) = zsh_term(
		"TERM=vt52; for k v in ${(kv)termcap}; do [[ $k == (me|bc|bs|le) ]] && print -r -- \
		 \"$k=${(q)v}\"; done; print -r -- \"<\"${(M)${(k)terminfo}:#OT(bc|i2|rs)}\">\" \
		 ${#terminfo}; echoti cols; for k v in ${(kv)termcap}; do [[ $k == (me|bc|bs|le) ]] && \
		 print -r -- \"$k=${(q)v}\"; done; print -r -- \"<\"${(M)${(k)terminfo}:#OT(bc|i2|rs)}\">\" \
		 ${#terminfo}",
		"xterm-256color",
	);
	assert_eq!(
		out,
		"bs=yes\nle=$'\\033'D\n<> 70\n80\nbs=no\nle=$'\\033'D\nbc=$'\\033'D\n<OTbc> 71\n"
	);
	assert_eq!(err, "");
	assert_eq!(status, 0);
}

/// `tgetent`'s obsolete defaults move `is3` to `OTi2` and a lone `rs2` to
/// `OTrs`.
#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "expects macOS's terminfo database")]
fn tgetent_moves_obsolete_defaults() {
	let (out, err, status) = zsh_term(
		"print -r -- \"<\"${(M)${(k)terminfo}:#(is3|OTi2|rs2|OTrs)}\">\"; print -r -- \
		 ${(q)terminfo[is3]}; print -r -- \"<\"${(M)${(k)terminfo}:#(is3|OTi2|rs2|OTrs)}\">\"; \
		 print -r -- \"<\"${(M)${(k)termcap}:#(i3|i2|r2|rs)}\">\"",
		"4410-w",
	);
	assert_eq!(out, "<is3 rs2>\n''\n<OTi2 OTrs>\n<i2 rs>\n");
	assert_eq!(err, "");
	assert_eq!(status, 0);
}
