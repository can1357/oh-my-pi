use pi_shell::bash::{MemStore, StateStore, store::{BlobSlot, Change, Key, Record, Table}};
use std::{path::{Path, PathBuf}, collections::BTreeMap};
fn records(store: &mut MemStore) -> BTreeMap<Vec<u8>, Vec<u8>> {
    let mut rows = BTreeMap::new();
    for table in [Table::Var,Table::Func,Table::Alias,Table::Opt,Table::Trap,Table::Job,Table::Proc,Table::DirStack,Table::CmdHash,Table::Misc,Table::Scope,Table::Local,Table::ZshOpt,Table::ZshAlias] {
        store.scan(table, &mut |k, r| { rows.insert(postcard::to_stdvec(&k.to_buf()).unwrap(), postcard::to_stdvec(r).unwrap()); }).unwrap();
    }
    rows
}
#[test]
fn produce_unknown_record_fixtures() {
    assert_eq!(env!("CARGO_PKG_VERSION"), "18.18.2");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/format-vocabulary");
    let out = PathBuf::from(std::env::var_os("UNKNOWN_FIXTURE_OUT").unwrap());
    std::fs::create_dir_all(&out).unwrap();
    for (name, input, ids) in [
        ("unknown-root-kept", "18.18.2-ir17/unknown-root-kept.image", &[(74u32,127u32)][..]),
        ("unknown-subshell-kept", "18.18.2-ir17/unknown-subshell-kept.image", &[(74,127)][..]),
    ] {
        let bytes=std::fs::read(root.join(input)).unwrap();
        let mut store=MemStore::from_bytes(&bytes).unwrap();
        let frames=store.get_blob(BlobSlot::Frames).unwrap();
        let mut before=records(&mut store);
        for &(old,new) in ids {
            let r: Record=store.get(Key::UnknownMisc(old)).unwrap().cloned().unwrap();
            store.apply(Change::Del(Key::UnknownMisc(old))).unwrap();
            store.apply(Change::Put(Key::UnknownMisc(new),r.clone())).unwrap();
            let oldkey=postcard::to_stdvec(&Key::UnknownMisc(old).to_buf()).unwrap();
            let newkey=postcard::to_stdvec(&Key::UnknownMisc(new).to_buf()).unwrap();
            let value=before.remove(&oldkey).unwrap();
            assert!(before.insert(newkey,value).is_none());
            std::fs::write(out.join(format!("{name}.record")),postcard::to_stdvec(&(Key::UnknownMisc(new).to_buf(),r)).unwrap()).unwrap();
        }
        if std::env::var_os("UNKNOWN_DROP_CONTROL").is_some() {
            store.apply(Change::Del(Key::UnknownMisc(127))).unwrap();
        }
        assert_eq!(records(&mut store),before);
        assert_eq!(store.get_blob(BlobSlot::Frames).unwrap(),frames);
        std::fs::write(out.join(format!("{name}.image")),store.to_bytes()).unwrap();
        println!("{name}: original Frames and every record payload preserved; 74 -> 127");
    }
}
