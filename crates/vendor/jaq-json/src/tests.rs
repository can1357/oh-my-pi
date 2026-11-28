//! Regression tests for deep values, and fixtures for the semantic contracts
//! of the iterative rewrites (printing bytes, containment, comparison,
//! deletion).
//!
//! The deep tests run on a deliberately small native stack: a per-level
//! recursive implementation would overflow it at depth 10 000, so passing
//! them shows that parsing, printing, comparing, merging, containment,
//! deletion and dropping no longer recurse on the native stack.

use super::*;
use alloc::string::String;
use alloc::vec::Vec;
use core::cmp::Ordering;
use jaq_core::{path::Opt, ValT as _};
use jaq_std::ValT as _;

fn arr(v: Vec<Val>) -> Val {
    Val::Arr(v.into())
}

fn obj(kv: Vec<(&str, Val)>) -> Val {
    let mut m = Map::with_capacity_and_hasher(0, Default::default());
    for (k, v) in kv {
        m.insert(Val::utf8_str(k.to_owned()), v);
    }
    Val::obj(m)
}

/// Print a value through the (iterative) writer, as `write` does.
fn iterative(pp: &write::Pp, v: &Val) -> String {
    let mut buf = Vec::new();
    write::write(&mut buf, pp, 0, v).unwrap();
    String::from_utf8(buf).unwrap()
}

#[test]
fn print_fixtures_compact_and_pretty() {
    // A small object: an array and an escaped string, inserted `b` then `a`.
    let v = obj(alloc::vec![
        ("b", arr(alloc::vec![Val::from(1isize), Val::Bool(true), Val::Null])),
        ("a", Val::utf8_str("x\ny".to_owned())),
    ]);
    assert_eq!(iterative(&write::Pp::default(), &v), "{\"b\":[1,true,null],\"a\":\"x\\ny\"}");
    assert_eq!(
        iterative(&write::Pp { sort_keys: true, ..Default::default() }, &v),
        "{\"a\":\"x\\ny\",\"b\":[1,true,null]}"
    );
    assert_eq!(
        iterative(&write::Pp { indent: Some("  ".into()), ..Default::default() }, &v),
        "{\n  \"b\":[\n    1,\n    true,\n    null\n  ],\n  \"a\":\"x\\ny\"\n}"
    );
    assert_eq!(
        iterative(
            &write::Pp {
                indent: Some(" ".into()),
                sort_keys: true,
                sep_space: true,
                ..Default::default()
            },
            &v
        ),
        "{\n \"a\": \"x\\ny\",\n \"b\": [\n  1,\n  true,\n  null\n ]\n}"
    );
    assert_eq!(alloc::format!("{v}"), "{\"b\":[1,true,null],\"a\":\"x\\ny\"}");

    // Non-ASCII text and byte strings, with and without `ascii`.
    let v = arr(alloc::vec![
        Val::utf8_str("é😀".to_owned()),
        Val::byte_str(alloc::vec![0u8, 0xff, b'"']),
    ]);
    assert_eq!(iterative(&write::Pp::default(), &v), "[\"é😀\",b\"\\x00\\xff\\\"\"]");
    assert_eq!(iterative(&write::Pp { ascii: true, ..Default::default() }, &v), "[\"\\u00e9\\ud83d\\ude00\",b\"\\x00\\xff\\\"\"]");
    assert_eq!(
        iterative(&write::Pp { indent: Some("  ".into()), ..Default::default() }, &v),
        "[\n  \"é😀\",\n  b\"\\x00\\xff\\\"\"\n]"
    );
}

#[test]
fn print_fixtures_styles() {
    // ANSI styling wraps every token separately, and object keys are printed
    // unstyled inside a key-style wrapper.
    let v1 = obj(alloc::vec![
        ("b", arr(alloc::vec![Val::from(1isize), Val::Bool(true), Val::Null])),
        ("a", Val::utf8_str("x\ny".to_owned())),
    ]);
    let ansi = write::Pp { styles: write::Styles::ansi(), ..Default::default() };
    assert_eq!(
        iterative(&ansi, &v1),
        "\u{1b}[1;39m{\u{1b}[0m\u{1b}[1;34m\"b\"\u{1b}[0m\u{1b}[1;39m:\u{1b}[0m\u{1b}[1;39m[\u{1b}[0m\u{1b}[39m1\u{1b}[0m,\u{1b}[39mtrue\u{1b}[0m,\u{1b}[90mnull\u{1b}[0m\u{1b}[1;39m]\u{1b}[0m,\u{1b}[1;34m\"a\"\u{1b}[0m\u{1b}[1;39m:\u{1b}[0m\u{1b}[32m\"x\\ny\"\u{1b}[0m\u{1b}[1;39m}\u{1b}[0m"
    );
    let v2 = arr(alloc::vec![
        Val::utf8_str("é😀".to_owned()),
        Val::byte_str(alloc::vec![0u8, 0xff, b'"']),
    ]);
    assert_eq!(
        iterative(&ansi, &v2),
        "\u{1b}[1;39m[\u{1b}[0m\u{1b}[32m\"é😀\"\u{1b}[0m,\u{1b}[31mb\"\\x00\\xff\\\"\"\u{1b}[0m\u{1b}[1;39m]\u{1b}[0m"
    );
    let v3 = obj(alloc::vec![("k", Val::Bool(true))]);
    assert_eq!(
        iterative(&ansi, &v3),
        "\u{1b}[1;39m{\u{1b}[0m\u{1b}[1;34m\"k\"\u{1b}[0m\u{1b}[1;39m:\u{1b}[0m\u{1b}[39mtrue\u{1b}[0m\u{1b}[1;39m}\u{1b}[0m"
    );
}

#[test]
fn contains_fixtures() {
    let a12 = arr(alloc::vec![Val::from(1isize), Val::from(2isize)]);
    assert_eq!(a12.contains(&arr(alloc::vec![Val::from(2isize)]), 0), Some(true));
    assert_eq!(a12.contains(&arr(alloc::vec![Val::from(3isize)]), 0), Some(false));
    assert_eq!(a12.contains(&arr(Vec::new()), 0), Some(true));

    let oab = obj(alloc::vec![("a", Val::from(1isize)), ("b", Val::from(2isize))]);
    assert_eq!(oab.contains(&obj(alloc::vec![("a", Val::from(1isize))]), 0), Some(true));
    assert_eq!(oab.contains(&obj(alloc::vec![("c", Val::from(1isize))]), 0), Some(false));
    assert_eq!(oab.contains(&obj(Vec::new()), 0), Some(true));

    // A missing key, an empty nested object, and strings.
    let nested = obj(alloc::vec![("a", obj(alloc::vec![("b", Val::from(1isize))]))]);
    assert_eq!(nested.contains(&obj(alloc::vec![("a", obj(Vec::new()))]), 0), Some(true));
    assert_eq!(nested.contains(&obj(alloc::vec![("a", obj(alloc::vec![("c", Val::from(1isize))]))]), 0), Some(false));
    assert_eq!(Val::utf8_str("abc").contains(&Val::utf8_str("b"), 0), Some(true));
    assert_eq!(Val::utf8_str("abc").contains(&Val::utf8_str("z"), 0), Some(false));
}

#[test]
fn compare_fixtures() {
    let cmp = |x: &Val, y: &Val| x.cmp_at(y, 0, 10000, false).map_err(|_| ());
    let cmp_nl = |x: &Val, y: &Val| x.cmp_at(y, 0, 10000, true).map_err(|_| ());

    // Key order does not matter; sorted keys decide the order.
    let ob1 = obj(alloc::vec![("b", Val::from(1isize)), ("a", Val::from(2isize))]);
    let ob2 = obj(alloc::vec![("a", Val::from(2isize)), ("b", Val::from(1isize))]);
    assert_eq!(ob1.eq_at(&ob2, 0, 10000).map_err(|_| ()), Ok(true));
    assert_eq!(cmp(&ob1, &ob2), Ok(Ordering::Equal));
    assert_eq!(
        cmp(
            &obj(alloc::vec![("a", Val::from(1isize))]),
            &obj(alloc::vec![("b", Val::from(1isize))])
        ),
        Ok(Ordering::Less)
    );
    assert_eq!(
        cmp(
            &arr(alloc::vec![Val::from(1isize), Val::from(2isize)]),
            &arr(alloc::vec![Val::from(1isize), Val::from(3isize)])
        ),
        Ok(Ordering::Less)
    );
    // A shorter array is smaller when it is a prefix.
    assert_eq!(
        cmp(
            &arr(alloc::vec![Val::from(1isize)]),
            &arr(alloc::vec![Val::from(1isize), Val::from(2isize)])
        ),
        Ok(Ordering::Less)
    );

    // NaN: with `nan_less` (jq's `<`) NaN is smaller than everything, even
    // itself; without it, NaNs are equal (so sorting stays a total order).
    let nan = Val::Num(Num::Float(f64::NAN));
    assert_eq!(cmp_nl(&Val::from(1isize), &nan), Ok(Ordering::Greater));
    assert_eq!(cmp_nl(&nan, &nan), Ok(Ordering::Less));
    assert_eq!(cmp(&nan, &nan), Ok(Ordering::Equal));
}

#[test]
fn delpaths_fixtures() {
    let mut root = Map::with_capacity_and_hasher(0, Default::default());
    let mut ab = Map::with_capacity_and_hasher(0, Default::default());
    ab.insert(Val::utf8_str("b"), Val::from(1isize));
    ab.insert(Val::utf8_str("c"), Val::from(2isize));
    root.insert(Val::utf8_str("a"), Val::obj(ab));
    root.insert(Val::utf8_str("c"), Val::from(3isize));
    root.insert(Val::utf8_str("d"), arr(alloc::vec![Val::from(1isize), Val::from(2isize), Val::from(3isize)]));
    root.insert(Val::utf8_str("e"), Val::Null);
    let node = Val::obj(root);
    let key = |k: &str| Val::utf8_str(k.to_owned());
    let idx = |i: isize| arr(alloc::vec![key("d"), Val::from(i)]);
    let unchanged = "{\"a\":{\"b\":1,\"c\":2},\"c\":3,\"d\":[1,2,3],\"e\":null}";

    let cases: Vec<(&str, Vec<Val>, Result<&str, &str>)> = alloc::vec![
        ("no paths", alloc::vec![], Ok(unchanged)),
        ("empty path", alloc::vec![arr(Vec::new())], Ok("null")),
        ("a", alloc::vec![arr(alloc::vec![key("a")])], Ok("{\"c\":3,\"d\":[1,2,3],\"e\":null}")),
        ("a.b", alloc::vec![arr(alloc::vec![key("a"), key("b")])], Ok("{\"a\":{\"c\":2},\"c\":3,\"d\":[1,2,3],\"e\":null}")),
        // Overlapping paths under the same parent collapse into one deletion.
        ("a.b + a.c", alloc::vec![arr(alloc::vec![key("a"), key("b")]), arr(alloc::vec![key("a"), key("c")])], Ok("{\"a\":{},\"c\":3,\"d\":[1,2,3],\"e\":null}")),
        // A whole subtree and a sibling key.
        ("a + c", alloc::vec![arr(alloc::vec![key("a")]), arr(alloc::vec![key("c")])], Ok("{\"d\":[1,2,3],\"e\":null}")),
        // Duplicate paths delete once.
        ("a.b + a.b", alloc::vec![arr(alloc::vec![key("a"), key("b")]), arr(alloc::vec![key("a"), key("b")])], Ok("{\"a\":{\"c\":2},\"c\":3,\"d\":[1,2,3],\"e\":null}")),
        ("d[1]", alloc::vec![idx(1)], Ok("{\"a\":{\"b\":1,\"c\":2},\"c\":3,\"d\":[1,3],\"e\":null}")),
        ("d[0] + d[2]", alloc::vec![idx(0), idx(2)], Ok("{\"a\":{\"b\":1,\"c\":2},\"c\":3,\"d\":[2],\"e\":null}")),
        // A path through a null child is a no-op.
        ("e.x", alloc::vec![arr(alloc::vec![key("e"), key("x")])], Ok(unchanged)),
        // A path through a scalar fails.
        ("c.x", alloc::vec![arr(alloc::vec![key("c"), key("x")])], Err("Cannot delete fields from number")),
    ];
    for (name, paths, expected) in cases {
        let result = node.clone().delpaths(&Val::Arr(paths.into()));
        match (&result, expected) {
            (Ok(v), Ok(exp)) => assert_eq!(alloc::format!("{v}"), exp, "delpaths {name}"),
            (Err(e), Err(exp)) => {
                let msg = alloc::format!("{e}");
                assert!(msg.contains(exp), "delpaths {name}: {msg}");
            }
            (Ok(v), Err(exp)) => panic!("delpaths {name}: expected error {exp}, got {v}"),
            (Err(e), Ok(exp)) => panic!("delpaths {name}: expected {exp}, got {e}"),
        }
    }
}

#[test]
fn clone_alias_cow_semantics() {
    // Cloning shares storage; updating one clone must not disturb the other.
    let a = arr(alloc::vec![Val::from(1isize), Val::from(2isize)]);
    let b = a.clone();
    let c = b.clone().set(&Val::from(0isize), Val::from(9isize)).unwrap();
    assert_eq!(alloc::format!("{a}"), "[1,2]");
    assert_eq!(alloc::format!("{c}"), "[9,2]");

    let o = obj(alloc::vec![("k", Val::from(1isize))]);
    let o2 = o.clone().set(&Val::utf8_str("k"), Val::from(2isize)).unwrap();
    assert_eq!(alloc::format!("{o}"), "{\"k\":1}");
    assert_eq!(alloc::format!("{o2}"), "{\"k\":2}");

    // A shared subvalue stays alive after the other holder is dropped.
    let sub = arr(alloc::vec![Val::from(7isize)]);
    let holder = arr(alloc::vec![sub.clone(), sub.clone()]);
    drop(holder);
    assert_eq!(alloc::format!("{sub}"), "[7]");
}

/// Run `f` on a stack small enough that per-level recursion would overflow.
fn on_small_stack<F: FnOnce() + Send + 'static>(f: F) {
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

fn nested_arr(n: usize, leaf: Val) -> Val {
    let mut v = leaf;
    for _ in 0..n {
        v = arr(alloc::vec![v]);
    }
    v
}

fn nested_obj(n: usize) -> Val {
    let mut v = Val::obj(Map::with_capacity_and_hasher(0, Default::default()));
    for _ in 0..n {
        v = obj(alloc::vec![("k", v)]);
    }
    v
}

#[test]
fn update_each_moves_children_in_order_and_keeps_the_alias() {
    for (input, expected) in [
        ("[1,2,null]", "[9,null]"),
        (r#"{"z":1,"a":2,"m":null}"#, r#"{"a":9,"m":null}"#),
    ] {
        let original = read::parse_single(input.as_bytes()).unwrap();
        let mut update = original.clone().update_values(Opt::Essential).unwrap();
        assert_eq!(update.next(), Some(Val::from(1isize)));
        update.put(None).unwrap();
        assert_eq!(update.next(), Some(Val::from(2isize)));
        update.put(Some(Val::from(9isize))).unwrap();
        assert_eq!(update.next(), Some(Val::Null));
        update.put(Some(Val::Null)).unwrap();
        assert!(update.next().is_none());
        assert_eq!(alloc::format!("{}", update.finish()), expected);
        assert_eq!(alloc::format!("{original}"), input);
    }
}

#[test]
fn update_index_preserves_absence_order_and_fractional_deletion() {
    let original = read::parse_single(br#"{"z":1,"a":2}"#).unwrap();
    let mut update = {
        let key = Val::utf8_str("m");
        original.clone().update_index(&key, Opt::Essential).unwrap()
    };
    assert_eq!(update.next(), Some(Val::Null));
    update.put(Some(Val::from(3isize))).unwrap();
    assert!(update.next().is_none());
    assert_eq!(alloc::format!("{}", update.finish()), r#"{"z":1,"a":2,"m":3}"#);

    let mut update = original.clone().update_index(&Val::utf8_str("z"), Opt::Essential).unwrap();
    assert_eq!(update.next(), Some(Val::from(1isize)));
    update.put(None).unwrap();
    assert_eq!(alloc::format!("{}", update.finish()), r#"{"a":2}"#);
    assert_eq!(alloc::format!("{original}"), r#"{"z":1,"a":2}"#);

    let arr = read::parse_single(b"[1,2]").unwrap();
    for (index, child, expected) in [(-0.5, 1, "[1,2]"), (-1.0, 2, "[1]")] {
        let mut update = arr.clone().update_index(&Val::from(index), Opt::Essential).unwrap();
        assert_eq!(update.next(), Some(Val::from(child as isize)));
        update.put(None).unwrap();
        assert_eq!(alloc::format!("{}", update.finish()), expected);
    }

    let mut update = arr.clone().update_index(&Val::utf8_str("a"), Opt::Optional).unwrap();
    assert!(update.next().is_none());
    assert_eq!(update.finish(), arr);
    let mut update = arr.clone().update_index(&Val::from(3isize), Opt::Essential).unwrap();
    assert_eq!(update.next(), Some(Val::Null));
    update.put(Some(Val::from(8isize))).unwrap();
    assert_eq!(alloc::format!("{}", update.finish()), "[1,2,null,8]");
    assert!(arr.update_index(&Val::utf8_str("a"), Opt::Essential).is_err());
}

#[test]
fn update_slice_preserves_replacement_deletion_and_errors() {
    let arr = read::parse_single(b"[0,1,2]").unwrap();
    let start = Val::from(1isize);
    let end = Val::from(2isize);
    for (replacement, expected) in [(None, "[0,2]"), (Some(read::parse_single(b"[8,9]").unwrap()), "[0,8,9,2]")] {
        let mut update = arr.clone().update_range(Some(&start)..Some(&end), Opt::Essential).unwrap();
        assert_eq!(update.next(), Some(read::parse_single(b"[1]").unwrap()));
        update.put(replacement).unwrap();
        assert_eq!(alloc::format!("{}", update.finish()), expected);
    }

    let mut update = Val::utf8_str("abc").update_range(Some(&start)..Some(&end), Opt::Optional).unwrap();
    assert_eq!(update.next(), Some(Val::utf8_str("b")));
    let error = update.put(Some(Val::utf8_str("q"))).unwrap_err();
    assert_eq!(alloc::format!("{error}"), r#""Cannot update string slices""#);

    let mut update = arr.clone().update_range(Some(&Val::Bool(true))..None, Opt::Optional).unwrap();
    assert!(update.next().is_none());
    assert_eq!(update.finish(), arr);

    let mut update = Val::Null.update_range(None..None, Opt::Essential).unwrap();
    assert_eq!(update.next(), Some(Val::Null));
    update.put(Some(arr.clone())).unwrap();
    assert_eq!(update.finish(), arr);
}

const DEPTH: usize = 10_000;

#[test]
fn deep_parse_print_compare_drop() {
    on_small_stack(|| {
        let text = alloc::format!("{}0{}", "[".repeat(DEPTH), "]".repeat(DEPTH));
        let v = read::parse_single(text.as_bytes()).unwrap();
        assert_eq!(alloc::format!("{v}"), text);
        let w = read::parse_single(text.as_bytes()).unwrap();
        assert!(v.try_eq(&w).unwrap());
        assert_eq!(v.try_cmp(&w).unwrap(), Ordering::Equal);
        assert_eq!(v.contains(&w, 0), Some(true));

        // The parser counts a pending object key towards the depth limit, so
        // build a deeply nested object directly for printing and comparing.
        let o = nested_obj(DEPTH);
        let o2 = nested_obj(DEPTH);
        assert_eq!(alloc::format!("{o}"), alloc::format!("{o2}"));
        assert!(o.try_eq(&o2).unwrap());
        assert_eq!(o.contains(&o2, 0), Some(true));
        drop(o);
        drop(o2);
        drop(v);
        drop(w);
    });
}

#[test]
fn depth_limit_and_beyond() {
    on_small_stack(|| {
        let ok = alloc::format!("{}0{}", "[".repeat(DEPTH), "]".repeat(DEPTH));
        assert!(read::parse_single(ok.as_bytes()).is_ok());
        let too = alloc::format!("{}0{}", "[".repeat(DEPTH + 1), "]".repeat(DEPTH + 1));
        let e = read::parse_single(too.as_bytes()).unwrap_err();
        assert!(e.message().contains("Exceeds depth limit"), "{}", e.message());

        // Comparing/checking equality beyond the depth limit fails, not overflows.
        let deep = nested_arr(DEPTH + 1, Val::from(0isize));
        let deep2 = nested_arr(DEPTH + 1, Val::from(0isize));
        assert!(deep.try_cmp(&deep2).is_err());
        assert!(deep.try_eq(&deep2).is_err());
        assert_eq!(deep.contains(&deep2, 0), None);

        // At the limit, everything still succeeds.
        let fine = nested_arr(DEPTH, Val::from(0isize));
        let fine2 = nested_arr(DEPTH, Val::from(0isize));
        assert_eq!(fine.try_cmp(&fine2).unwrap(), Ordering::Equal);
        assert!(fine.try_eq(&fine2).unwrap());
        assert_eq!(fine.contains(&fine2, 0), Some(true));
    });
}

#[test]
fn write_depth_limit() {
    let v = nested_arr(DEPTH + 1, Val::from(0isize));
    assert!(alloc::format!("{v}").contains(write::TOO_DEEP));
    let fine = nested_arr(DEPTH, Val::from(0isize));
    assert!(!alloc::format!("{fine}").contains(write::TOO_DEEP));
}

#[test]
fn deep_merge() {
    on_small_stack(|| {
        let o = nested_obj(DEPTH);
        let merged = o.clone() * o.clone();
        assert!(merged.is_ok());
        assert!(merged.unwrap().try_eq(&o).unwrap());

        let deep = nested_obj(DEPTH + 1);
        assert!((deep.clone() * deep.clone()).is_err());
    });
}

#[test]
fn deep_drop_shared() {
    on_small_stack(|| {
        let deep = nested_arr(DEPTH, Val::from(0isize));
        let keep = deep.clone();
        // `holder` shares `keep`'s outermost array, so dropping it must not
        // free the subtree that `keep` still refers to.
        let holder = arr(alloc::vec![deep, keep.clone()]);
        drop(holder);
        assert_eq!(
            alloc::format!("{keep}"),
            alloc::format!("{}0{}", "[".repeat(DEPTH), "]".repeat(DEPTH))
        );
        drop(keep);

        // Deeply nested objects also drop iteratively.
        let o = nested_obj(DEPTH + 1);
        drop(o);
    });
}

#[test]
fn deep_delpaths() {
    on_small_stack(|| {
        let node = nested_arr(DEPTH, Val::from(0isize));
        let zeros: Vec<Val> = core::iter::repeat_with(|| Val::from(0isize)).take(DEPTH).collect();
        let paths = arr(alloc::vec![arr(zeros)]);
        assert!(node.clone().delpaths(&paths).is_ok());
        // One beyond the path depth limit is rejected, not overflowed.
        let too: Vec<Val> = core::iter::repeat_with(|| Val::from(0isize)).take(DEPTH + 1).collect();
        assert!(node.delpaths(&arr(alloc::vec![arr(too)])).is_err());
    });
}
