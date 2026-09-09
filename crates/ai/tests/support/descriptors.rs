use std::collections::{BTreeMap, BTreeSet};

use prost_types::{DescriptorProto, EnumDescriptorProto, FileDescriptorSet};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DescriptorShape {
	pub messages: BTreeMap<String, MessageShape>,
	pub enums:    BTreeMap<String, BTreeSet<(i32, String)>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageShape {
	pub fields: BTreeMap<i32, FieldShape>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FieldShape {
	pub name:      String,
	pub kind:      i32,
	pub label:     i32,
	pub type_name: String,
	pub oneof:     Option<String>,
}

pub fn shape(descriptors: &FileDescriptorSet) -> DescriptorShape {
	let mut shape = DescriptorShape { messages: BTreeMap::new(), enums: BTreeMap::new() };
	for file in &descriptors.file {
		let package = file.package.as_deref().unwrap_or_default();
		for message in &file.message_type {
			visit_message(&mut shape, package, message);
		}
		for enumeration in &file.enum_type {
			visit_enum(&mut shape, package, enumeration);
		}
	}
	shape
}

fn visit_message(shape: &mut DescriptorShape, parent: &str, message: &DescriptorProto) {
	let name = qualified(parent, message.name.as_deref().expect("message without a name"));
	let oneofs: Vec<_> = message
		.oneof_decl
		.iter()
		.map(|oneof| oneof.name.as_deref().expect("oneof without a name"))
		.collect();
	let fields = message
		.field
		.iter()
		.map(|field| {
			let tag = field.number.expect("field without a tag");
			let oneof = field
				.oneof_index
				.map(|index| oneofs[usize::try_from(index).expect("negative oneof index")].to_owned());
			(tag, FieldShape {
				name: field.name.clone().expect("field without a name"),
				kind: field.r#type.expect("field without a type"),
				label: field.label.expect("field without a label"),
				type_name: field.type_name.clone().unwrap_or_default(),
				oneof,
			})
		})
		.collect();
	assert!(
		shape
			.messages
			.insert(name.clone(), MessageShape { fields })
			.is_none(),
		"duplicate message {name}"
	);
	for nested in &message.nested_type {
		visit_message(shape, &name, nested);
	}
	for enumeration in &message.enum_type {
		visit_enum(shape, &name, enumeration);
	}
}

fn visit_enum(shape: &mut DescriptorShape, parent: &str, enumeration: &EnumDescriptorProto) {
	let name = qualified(parent, enumeration.name.as_deref().expect("enum without a name"));
	let values = enumeration
		.value
		.iter()
		.map(|value| {
			(
				value.number.expect("enum value without a number"),
				value.name.clone().expect("enum value without a name"),
			)
		})
		.collect();
	assert!(shape.enums.insert(name.clone(), values).is_none(), "duplicate enum {name}");
}

fn qualified(parent: &str, name: &str) -> String {
	if parent.is_empty() {
		name.to_owned()
	} else {
		format!("{parent}.{name}")
	}
}
