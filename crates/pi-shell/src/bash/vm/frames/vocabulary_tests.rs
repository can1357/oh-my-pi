//! A debug test-build consumer. This module cannot exist in shipped binaries.

use bstr::BString;

use super::*;
use crate::{
	bash::snapshot::vocabulary::{Codec, Definition, Entry},
	testkit::FakeHost,
};

const DEFINITION: Definition =
	Definition { id: 65537, revision: 7, required: true, per_vproc: true };

pub(crate) static CODEC: ProbeCodec = ProbeCodec;
pub(crate) struct ProbeCodec;

impl Codec for ProbeCodec {
	fn definition(&self) -> Definition {
		DEFINITION
	}

	fn capture(&self, shell: &Shell, entries: &mut Vec<Entry>) -> Result<(), postcard::Error> {
		for vp in &shell.procs {
			if let Some(value) = vp.cwd.strip_prefix(b"/vocabulary-") {
				let value = std::str::from_utf8(value)
					.map_err(|_| postcard::Error::SerdeSerCustom)?
					.parse::<u8>()
					.map_err(|_| postcard::Error::SerdeSerCustom)?;
				entries.push(DEFINITION.encode(Some(vp.vpid), &[0, value, 128, 2, 0, 0, 9])?);
			}
		}
		Ok(())
	}

	fn restore(&self, shell: &mut Shell, entry: Entry) -> Result<(), RestoreError> {
		let value: [u8; 7] = DEFINITION.decode(&entry).map_err(RestoreError::Corrupt)?;
		if value[0] != 0 || value[2..] != [128, 2, 0, 0, 9] {
			return Err(RestoreError::Corrupt(postcard::Error::SerdeDeCustom));
		}
		let vp = shell
			.procs
			.iter_mut()
			.find(|vp| Some(vp.vpid) == entry.vpid)
			.ok_or(RestoreError::Corrupt(postcard::Error::SerdeDeCustom))?;
		vp.cwd = BString::from(format!("/vocabulary-{}", value[1]));
		Ok(())
	}
}

#[test]
fn a_known_required_codec_restores_and_recaptures_only_its_owning_vproc() {
	let bytes = include_bytes!(
		"../../../../tests/fixtures/format-vocabulary/18.18.8-ir17/owned-required.image"
	);
	let engine = Engine::new(crate::bash::EngineConfig::default());
	let mut store = crate::bash::MemStore::from_bytes(bytes).unwrap();
	let mut host = FakeHost::new();
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.unwrap();
	assert!(report.lost.is_empty(), "the built-in decoder must actually apply the required entry");
	assert_eq!((report.vprocs, report.runs), (2, 1));
	let root_cwd = shell
		.procs
		.iter()
		.find(|vp| vp.parent.is_none())
		.unwrap()
		.cwd
		.clone();
	assert_ne!(root_cwd.as_slice(), b"/vocabulary-255");
	assert_eq!(
		shell
			.api(&mut Cx { host: &mut host, store: &mut store }, crate::bash::CallId(1))
			.unwrap()
			.cwd(),
		bstr::BStr::new("/vocabulary-255")
	);
	for _ in 0..2 {
		shell.control().request_suspend();
		assert!(matches!(
			shell.step(&mut Cx { host: &mut host, store: &mut store }, crate::bash::Budget::default()),
			crate::bash::Step::SuspendReady
		));
		shell
			.externalize(&mut Cx { host: &mut host, store: &mut store })
			.unwrap();
		let frames = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
		let (header, body) = postcard::take_from_bytes::<Header>(&frames).unwrap();
		assert_eq!(header.magic, VOCABULARY_MAGIC);
		let (envelope, rest) =
			postcard::take_from_bytes::<crate::bash::snapshot::vocabulary::Envelope<'_>>(body)
				.unwrap();
		assert!(rest.is_empty());
		assert_eq!(envelope.entries.as_ref(), &[Entry {
			id:       65537,
			revision: 7,
			required: true,
			vpid:     Some(Vpid(1)),
			payload:  vec![0, 255, 128, 2, 0, 0, 9],
		}]);
		let (restored, report) = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.unwrap();
		assert!(report.lost.is_empty());
		shell = restored;
		assert_eq!(
			shell
				.procs
				.iter()
				.find(|vp| vp.parent.is_none())
				.unwrap()
				.cwd,
			root_cwd
		);
		assert_eq!(
			shell
				.api(&mut Cx { host: &mut host, store: &mut store }, crate::bash::CallId(1))
				.unwrap()
				.cwd(),
			bstr::BStr::new("/vocabulary-255")
		);
	}
	shell.complete(crate::bash::CallId(1), crate::bash::CallOutcome::Exit(0));
	let mut idle = false;
	for _ in 0..10_000 {
		match shell
			.step(&mut Cx { host: &mut host, store: &mut store }, crate::bash::Budget::default())
		{
			crate::bash::Step::Idle => {
				idle = true;
				break;
			},
			crate::bash::Step::Done { .. } | crate::bash::Step::Yield => {},
			other => panic!("restored consumer state disrupted execution: {other:?}"),
		}
	}
	assert!(idle);
	assert_eq!(host.stdout.bytes(), b"child=23\n");
}
