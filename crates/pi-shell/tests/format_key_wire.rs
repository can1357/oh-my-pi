use pi_shell::bash::store::{KeyBuf, MiscKey};

#[test]
fn named_misc_json_still_decodes_to_the_original_binary_key() {
	let wire = r#"{"Misc":"Profile"}"#;
	let key: KeyBuf =
		serde_json::from_str(wire).expect("known human-readable Misc names remain compatible");
	assert_eq!(key, KeyBuf::Misc(MiscKey::Profile));
	assert_eq!(postcard::to_stdvec(&key).unwrap(), vec![9, 73]);
	assert_eq!(serde_json::to_string(&key).unwrap(), wire);
}

#[test]
fn an_unknown_numeric_misc_key_preserves_its_binary_and_human_readable_identity() {
	let key: KeyBuf = postcard::from_bytes(&[9, 76]).unwrap();
	assert_eq!(key, KeyBuf::UnknownMisc(76));
	assert_eq!(serde_json::to_string(&key).unwrap(), r#"{"Misc":76}"#);
	assert_eq!(postcard::to_stdvec(&key).unwrap(), vec![9, 76]);
}
