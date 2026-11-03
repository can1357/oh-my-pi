//! The bench-driver workloads with the iteration count as a parameter, for
//! the in-proc benches.

/// A kit workload in-proc.
#[derive(Clone, Copy, Debug)]
pub enum Workload {
	/// `while [ ]` counting loop.
	Loop,
	/// A function call per iteration.
	Func,
	/// `${s##*/}`, `${s%.*}` and `${#s}` per iteration.
	Strops,
}

impl Workload {
	/// Name as the bench driver prints it.
	pub const fn name(self) -> &'static str {
		match self {
			Self::Loop => "loop",
			Self::Func => "func",
			Self::Strops => "strops",
		}
	}

	/// The kit's script with `n` iterations.
	pub fn script(self, n: u32) -> Vec<u8> {
		match self {
			Self::Loop => format!(r#"i=0; while [ "$i" -lt {n} ]; do i=$((i+1)); done"#),
			Self::Func => {
				format!(r#"f() {{ x=$1; }}; i=0; while [ "$i" -lt {n} ]; do f "$i"; i=$((i+1)); done"#)
			},
			Self::Strops => format!(
				r#"s=/usr/local/lib/foo.tar.gz; i=0; while [ "$i" -lt {n} ]; do a=${{s##*/}}; b=${{s%.*}}; c=${{#s}}; i=$((i+1)); done"#
			),
		}
		.into_bytes()
	}
}
