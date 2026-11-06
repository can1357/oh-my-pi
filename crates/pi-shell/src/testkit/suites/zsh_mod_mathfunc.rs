//! zsh/mathfunc (port of zsh 5.9 `Src/Modules/mathfunc.c`). Expected
//! output comes from `/bin/zsh -f -c` 5.9.

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

#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "last-digit results are macOS libm's")]
fn every_function_on_sample_arguments() {
	let (out, err, st) = zsh(
		"zmodload zsh/mathfunc; print $(( abs(-3) )) $(( abs(-2.5) )) $(( acos(0.5) )) $(( \
		 asin(0.5) )) $(( atan(1) )) $(( atan(1,2) )) $(( cbrt(27) )) $(( ceil(1.2) )) $(( \
		 copysign(3,-1) )) $(( cos(1) )) $(( cosh(1) )) $(( exp(1) )) $(( expm1(1e-10) )) $(( \
		 fabs(-4) )) $(( float(3) )) $(( floor(-1.5) )) $(( fmod(7,3) )) $(( gamma(5) )) $(( \
		 hypot(3,4) )) $(( ilogb(8) )) $(( int(-3.7) )) $(( ldexp(3,2) )) $(( log(1) )) $(( \
		 log10(1000) )) $(( log1p(0) )) $(( log2(8) )) $(( logb(10) )) $(( nextafter(1,2) )) $(( \
		 rint(2.5) )) $(( scalb(3,2) )) $(( sin(0) )) $(( sinh(0) )) $(( sqrt(16) )) $(( tan(0) )) \
		 $(( tanh(0) )) $(( sqrt(-1) )) $(( log(0) )) $(( erf(0) )) $(( erfc(0) )) $(( j0(0) )) $(( \
		 j1(0) )) $(( jn(2,0) )) $(( y0(0) )) $(( lgamma(1) )) $((signgam()))",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"3 2.5 1.0471975511965976 0.52359877559829882 0.78539816339744828 0.46364760900080609 3. 2. \
		 -3. 0.54030230586813977 1.5430806348152437 2.7182818284590451 1.00000000005e-10 4. 3. -2. \
		 1. 24. 5. 3 -3 12. 0. 3. 0. 3. 3. 1.0000000000000002 2. 12. 0. 0. 4. 0. 0. NaN -Inf 0. 1. \
		 1. 0. 0. -Inf 0. 1\n"
	);
	assert_eq!(st, 0);
}

#[test]
#[cfg_attr(not(target_os = "macos"), ignore = "last-digit results are macOS libm's")]
fn lgamma_sets_signgam_and_common_values() {
	let (out, ..) = zsh(
		"zmodload zsh/mathfunc; print $(( lgamma(-0.5) )) $((signgam())); print $(( sin(1) )) $(( \
		 exp(1) )) $(( sqrt(2) )); print $(( ilogb(0) )) $(( int(1e300) ))",
	);
	assert_eq!(
		out,
		"1.2655121234846454 -1\n0.8414709848078965 2.7182818284590451 \
		 1.4142135623730951\n-2147483648 9223372036854775807\n"
	);
}

#[test]
fn wrong_argument_counts() {
	for (call, msg) in [
		("sin()", "zsh:1: wrong number of arguments: sin()\n"),
		("atan(1,2,3)", "zsh:1: wrong number of arguments: atan(1,2,3)\n"),
		("signgam(1)", "zsh:1: wrong number of arguments: signgam(1)\n"),
		("copysign(1)", "zsh:1: wrong number of arguments: copysign(1)\n"),
	] {
		let (out, err, st) = zsh(&format!("zmodload zsh/mathfunc; print $(( {call} ))"));
		assert_eq!((out.as_str(), err.as_str(), st), ("", msg, 1), "{call}");
	}
}

#[test]
fn rand48_with_a_seed_parameter_is_deterministic() {
	let (out, err, _) = zsh(
		"zmodload zsh/mathfunc; s=0123456789ab; print $(( rand48(s) )) $s; s=000000000000; print \
		 $(( rand48(s) )) $s; print $(( rand48( s ) )) $s; s=FFFFFFFFFFFF; print $(( rand48(s) )) \
		 $s; s=xyz; (( rand48(s) >= 0 )); print ${#s}",
	);
	assert_eq!(err, "");
	assert_eq!(
		out,
		"0.81993854905699237 edf27e24d1e7\n3.907985046680551e-14 \
		 000b00000000\n0.00098539467465030839 e6ba942d0040\n0.99991041866598351 199e2113fffa\n12\n"
	);
}
