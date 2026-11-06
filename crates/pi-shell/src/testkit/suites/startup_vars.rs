//! Variables bash sets at startup from host facts.

use crate::testkit::{FakeHost, Fault, run_script};

/// `GROUPS` lists the real gid first, then the other supplementary groups
/// (`FakeHost`: gid 1000, groups 1000 and 27), and ignores assignments like
/// bash's `noassign` attribute (`dynvar.tests`: `GROUPS[0]=-1`).
#[test]
fn groups_lists_real_gid_first_and_ignores_assignment() {
	let src =
		"echo \"${GROUPS[@]}\"; GROUPS[0]=-1; GROUPS=(5); echo \"$? ${GROUPS[0]} ${#GROUPS[@]}\"";
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "1000 27\n0 1000 2\n");
	assert_eq!(String::from_utf8_lossy(&out.stderr), "");
}
