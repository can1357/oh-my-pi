use super::{array_set, err, index_err, int_index, iter_err, parse_slice, slice_key};
use super::{ArrData, Error, Map, ObjData, Rc, Val};
use alloc::{boxed::Box, vec::Vec};
use core::{mem, ops::Range};
use jaq_core::{
    path::Opt,
    val::{ValR, ValueUpdate},
};

pub(super) type Cursor = Box<dyn ValueUpdate<Val>>;

pub(super) fn values(value: Val, opt: Opt) -> ValR<Cursor, Val> {
    Ok(match value {
        Val::Arr(a) => Box::new(Array { items: a.into_vec(), read: 0, written: 0 }),
        Val::Obj(o) => Box::new(Object {
            out: Map::with_capacity_and_hasher(o.len(), Default::default()),
            items: o.into_map().into_iter(),
            key: None,
        }),
        v => return inaccessible(v, opt, iter_err),
    })
}

struct Array {
    items: Vec<Val>,
    read: usize,
    written: usize,
}

impl ValueUpdate<Val> for Array {
    fn next(&mut self) -> Option<Val> {
        let child = mem::take(self.items.get_mut(self.read)?);
        self.read += 1;
        Some(child)
    }

    fn put(&mut self, value: Option<Val>) -> ValR<(), Val> {
        if let Some(value) = value {
            self.items[self.written] = value;
            self.written += 1;
        }
        Ok(())
    }

    fn finish(mut self: Box<Self>) -> Val {
        self.items.truncate(self.written);
        Val::Arr(self.items.into())
    }
}

struct Object {
    items: indexmap::map::IntoIter<Val, Val>,
    out: Map,
    key: Option<Val>,
}

impl ValueUpdate<Val> for Object {
    fn next(&mut self) -> Option<Val> {
        let (key, value) = self.items.next()?;
        self.key = Some(key);
        Some(value)
    }

    fn put(&mut self, value: Option<Val>) -> ValR<(), Val> {
        let key = self.key.take().expect("put follows next");
        if let Some(value) = value {
            self.out.insert(key, value);
        }
        Ok(())
    }

    fn finish(self: Box<Self>) -> Val {
        Val::obj(self.out)
    }
}

struct Single {
    child: Option<Val>,
    slot: Slot,
}

/// The suspended parent and the location to store the child's result.
enum Slot {
    Done(Val),
    ExistingKey(ObjData, usize),
    MissingKey(ObjData, Val),
    Element(ArrData, i64, Option<usize>),
    Slice(ArrData, Range<usize>),
    StringSlice,
    Index(Val, Val),
}

impl Single {
    fn at(child: Val, slot: Slot) -> Cursor {
        Box::new(Self { child: Some(child), slot })
    }
}

impl ValueUpdate<Val> for Single {
    fn next(&mut self) -> Option<Val> {
        self.child.take()
    }

    fn put(&mut self, value: Option<Val>) -> ValR<(), Val> {
        self.slot = Slot::Done(mem::replace(&mut self.slot, Slot::Done(Val::Null)).put(value)?);
        Ok(())
    }

    fn finish(self: Box<Self>) -> Val {
        let Slot::Done(value) = self.slot else { unreachable!("finish follows the last put") };
        value
    }
}

impl Slot {
    fn put(self, value: Option<Val>) -> ValR<Val> {
        Ok(match self {
            Self::Done(_) => unreachable!("put follows next"),
            Self::ExistingKey(mut obj, index) => {
                let obj_mut = Rc::make_mut(&mut obj);
                match value {
                    Some(value) => obj_mut[index] = value,
                    None => {
                        obj_mut.shift_remove_index(index);
                    }
                }
                Val::Obj(obj)
            }
            Self::MissingKey(mut obj, key) => {
                if let Some(value) = value {
                    Rc::make_mut(&mut obj).insert(key, value);
                }
                Val::Obj(obj)
            }
            Self::Element(mut arr, index, delete) => {
                if let Some(value) = value {
                    array_set(Rc::make_mut(&mut arr), index, value)?;
                } else if let Some(delete) = delete {
                    Rc::make_mut(&mut arr).remove(delete);
                }
                Val::Arr(arr)
            }
            Self::Slice(mut arr, range) => {
                match value {
                    Some(Val::Arr(values)) => {
                        Rc::make_mut(&mut arr).splice(range, values.iter().cloned());
                    }
                    Some(_) => return Err(err("A slice of an array can only be assigned another array")),
                    None => {
                        Rc::make_mut(&mut arr).drain(range);
                    }
                }
                Val::Arr(arr)
            }
            Self::StringSlice => return Err(err(if value.is_some() {
                "Cannot update string slices"
            } else {
                "Cannot delete fields from string"
            })),
            Self::Index(parent, key) => return match value {
                Some(value) => parent.set(&key, value),
                None => parent.dels(core::slice::from_ref(&key)),
            },
        })
    }
}

fn inaccessible(value: Val, opt: Opt, error: impl FnOnce(&Val) -> Error) -> ValR<Cursor, Val> {
    let value = opt.fail(value, |v| error(&v))?;
    Ok(Box::new(Single { child: None, slot: Slot::Done(value) }))
}

pub(super) fn index(parent: Val, index: &Val, opt: Opt) -> ValR<Cursor, Val> {
    Ok(match (parent, index) {
        (v @ (Val::Arr(_) | Val::TStr(_) | Val::BStr(_) | Val::Null), Val::Obj(o)) => {
            let start = o.get(&Val::utf8_str("start"));
            let end = o.get(&Val::utf8_str("end"));
            return slice(v, start, end, Some(index), opt);
        }
        (Val::Obj(mut obj), Val::TStr(_) | Val::BStr(_)) => {
            match obj.get_index_of(index) {
                Some(i) => {
                    let child = mem::take(&mut Rc::make_mut(&mut obj)[i]);
                    Single::at(child, Slot::ExistingKey(obj, i))
                }
                None => Single::at(Val::Null, Slot::MissingKey(obj, index.clone())),
            }
        }
        (Val::Arr(mut arr), Val::Num(n)) if !n.is_nan() => {
            let d = n.as_f64();
            let index = int_index(d);
            let len = arr.len() as i64;
            let read = if index < 0 { len + index } else { index };
            // jq deletes a negative index counted from the end. In particular,
            // `-0.5` reads array element 0 but deletes nothing.
            let delete = if d < 0.0 { len + index } else { index };
            let in_bounds = |i| (0..len).contains(&i).then_some(i as usize);
            let child = match in_bounds(read) {
                Some(i) if read == delete => mem::take(&mut Rc::make_mut(&mut arr)[i]),
                Some(i) => arr[i].clone(),
                None => Val::Null,
            };
            Single::at(child, Slot::Element(arr, index, in_bounds(delete)))
        }
        (v, k) => {
            let child = match v.clone().get(k) {
                Ok(child) => child,
                Err(e) => return inaccessible(v, opt, |_| e),
            };
            Single::at(child, Slot::Index(v, k.clone()))
        }
    })
}

pub(super) fn slice(
    parent: Val,
    start: Option<&Val>,
    end: Option<&Val>,
    key: Option<&Val>,
    opt: Opt,
) -> ValR<Cursor, Val> {
    let key = || key.cloned().unwrap_or_else(|| slice_key(start, end));
    Ok(match parent {
        Val::Null => Single::at(Val::Null, Slot::Index(Val::Null, key())),
        Val::Arr(arr) => {
            let (s, e) = match parse_slice(arr.len(), start, end) {
                Ok(bounds) => bounds,
                Err(e) => return inaccessible(Val::Arr(arr), opt, |_| e),
            };
            let child = Val::Arr(arr[s..e].to_vec().into());
            Single::at(child, Slot::Slice(arr, s..e))
        }
        v @ (Val::TStr(_) | Val::BStr(_)) => {
            let child = match v.clone().get_slice(start, end, None) {
                Ok(child) => child,
                Err(e) => return inaccessible(v, opt, |_| e),
            };
            Single::at(child, Slot::StringSlice)
        }
        v => return inaccessible(v, opt, |v| index_err(v, &key())),
    })
}
