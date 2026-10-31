use std::{env, path::PathBuf};

mod builder;

fn main() {
	let mut arguments = env::args_os().skip(1);
	let output = PathBuf::from(arguments.next().expect("expected syntax-set output path"));
	assert!(arguments.next().is_none(), "expected only a syntax-set output path");
	syntect::dumps::dump_to_uncompressed_file(&builder::build_syntax_set(), &output)
		.unwrap_or_else(|error| panic!("failed to write {}: {error}", output.display()));
}
