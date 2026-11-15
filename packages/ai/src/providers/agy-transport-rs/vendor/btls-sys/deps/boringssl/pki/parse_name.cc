// Copyright 2016 The Chromium Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "parse_name.h"

#include <cassert>

#include <openssl/bytestring.h>
#include <openssl/mem.h>

#include "parse_values.h"
#include "string_util.h"

BSSL_NAMESPACE_BEGIN

namespace {

// Returns a string containing the dotted numeric form of |oid|, or an empty
// string on error.
std::string OidToString(der::Input oid) {
  CBS cbs;
  CBS_init(&cbs, oid.data(), oid.size());
  bssl::UniquePtr<char> text(CBS_asn1_oid_to_text(&cbs));
  if (!text) {
    return std::string();
  }
  return text.get();
}

}  // namespace

bool X509NameAttribute::ValueAsString(std::string *out) const {
  switch (value_tag) {
    case CBS_ASN1_T61STRING:
      return der::ParseTeletexStringAsLatin1(value, out);
    case CBS_ASN1_IA5STRING:
      return der::ParseIA5String(value, out);
    case CBS_ASN1_PRINTABLESTRING:
      return der::ParsePrintableString(value, out);
    case CBS_ASN1_UTF8STRING:
      *out = BytesAsStringView(value);
      return true;
    case CBS_ASN1_UNIVERSALSTRING:
      return der::ParseUniversalString(value, out);
    case CBS_ASN1_BMPSTRING:
      return der::ParseBmpString(value, out);
    default:
      return false;
  }
}

bool X509NameAttribute::ValueAsStringWithUnsafeOptions(
    PrintableStringHandling printable_string_handling, std::string *out) const {
  if (printable_string_handling == PrintableStringHandling::kAsUTF8Hack &&
      value_tag == CBS_ASN1_PRINTABLESTRING) {
    *out = BytesAsStringView(value);
    return true;
  }
  return ValueAsString(out);
}

bool X509NameAttribute::ValueAsStringUnsafe(std::string *out) const {
  switch (value_tag) {
    case CBS_ASN1_IA5STRING:
    case CBS_ASN1_PRINTABLESTRING:
    case CBS_ASN1_T61STRING:
    case CBS_ASN1_UTF8STRING:
      *out = BytesAsStringView(value);
      return true;
    case CBS_ASN1_UNIVERSALSTRING:
      return der::ParseUniversalString(value, out);
    case CBS_ASN1_BMPSTRING:
      return der::ParseBmpString(value, out);
    default:
      assert(0);  // NOTREACHED
      return false;
  }
}

bool X509NameAttribute::AsRFC2253String(std::string *out) const {
  std::string type_string;
  std::string value_string;
  // TODO(mattm): Add streetAddress and domainComponent here?
  if (type == der::Input(kTypeCommonNameOid)) {
    type_string = "CN";
  } else if (type == der::Input(kTypeSurnameOid)) {
    type_string = "SN";
  } else if (type == der::Input(kTypeCountryNameOid)) {
    type_string = "C";
  } else if (type == der::Input(kTypeLocalityNameOid)) {
    type_string = "L";
  } else if (type == der::Input(kTypeStateOrProvinceNameOid)) {
    type_string = "ST";
  } else if (type == der::Input(kTypeOrganizationNameOid)) {
    type_string = "O";
  } else if (type == der::Input(kTypeOrganizationUnitNameOid)) {
    type_string = "OU";
  } else if (type == der::Input(kTypeGivenNameOid)) {
    type_string = "givenName";
  } else if (type == der::Input(kTypeEmailAddressOid)) {
    type_string = "emailAddress";
  } else {
    type_string = OidToString(type);
    if (type_string.empty()) {
      return false;
    }
    value_string = "#" + bssl::string_util::HexEncode(value);
  }

  if (value_string.empty()) {
    std::string unescaped;
    if (!ValueAsStringUnsafe(&unescaped)) {
      return false;
    }

    bool nonprintable = false;
    for (unsigned int i = 0; i < unescaped.length(); ++i) {
      uint8_t c = static_cast<uint8_t>(unescaped[i]);
      if (i == 0 && c == '#') {
        value_string += "\\#";
      } else if (i == 0 && c == ' ') {
        value_string += "\\ ";
      } else if (i == unescaped.length() - 1 && c == ' ') {
        value_string += "\\ ";
      } else if (c == ',' || c == '+' || c == '"' || c == '\\' || c == '<' ||
                 c == '>' || c == ';') {
        value_string += "\\";
        value_string += c;
      } else if (c < 32 || c > 126) {
        nonprintable = true;
        value_string += "\\" + bssl::string_util::HexEncode(Span(&c, 1));
      } else {
        value_string += c;
      }
    }

    // If we have non-printable characters in a TeletexString, we hex encode
    // since we don't handle Teletex control codes.
    if (nonprintable && value_tag == CBS_ASN1_T61STRING) {
      value_string = "#" + bssl::string_util::HexEncode(value);
    }
  }

  *out = type_string + "=" + value_string;
  return true;
}

bool ReadRdn(der::Parser *parser, RelativeDistinguishedName *out) {
  while (parser->HasMore()) {
    der::Parser attr_type_and_value;
    if (!parser->ReadSequence(&attr_type_and_value)) {
      return false;
    }
    // Read the attribute type, which must be an OBJECT IDENTIFIER.
    der::Input type;
    if (!attr_type_and_value.ReadTag(CBS_ASN1_OBJECT, &type)) {
      return false;
    }

    // Read the attribute value.
    CBS_ASN1_TAG tag;
    der::Input value;
    if (!attr_type_and_value.ReadTagAndValue(&tag, &value)) {
      return false;
    }

    // There should be no more elements in the sequence after reading the
    // attribute type and value.
    if (attr_type_and_value.HasMore()) {
      return false;
    }

    out->push_back(X509NameAttribute(type, tag, value));
  }

  // RFC 5280 section 4.1.2.4
  // RelativeDistinguishedName ::= SET SIZE (1..MAX) OF AttributeTypeAndValue
  return out->size() != 0;
}

bool ParseName(der::Input name_tlv, RDNSequence *out) {
  der::Parser name_parser(name_tlv);
  der::Input name_value;
  if (!name_parser.ReadTag(CBS_ASN1_SEQUENCE, &name_value)) {
    return false;
  }
  return ParseNameValue(name_value, out);
}

bool ParseNameValue(der::Input name_value, RDNSequence *out) {
  der::Parser rdn_sequence_parser(name_value);
  while (rdn_sequence_parser.HasMore()) {
    der::Parser rdn_parser;
    if (!rdn_sequence_parser.ReadConstructed(CBS_ASN1_SET, &rdn_parser)) {
      return false;
    }
    RelativeDistinguishedName type_and_values;
    if (!ReadRdn(&rdn_parser, &type_and_values)) {
      return false;
    }
    out->push_back(type_and_values);
  }

  return true;
}

bool ConvertToRFC2253(const RDNSequence &rdn_sequence, std::string *out) {
  std::string rdns_string;
  size_t size = rdn_sequence.size();
  for (size_t i = 0; i < size; ++i) {
    RelativeDistinguishedName rdn = rdn_sequence[size - i - 1];
    std::string rdn_string;
    for (const auto &atv : rdn) {
      if (!rdn_string.empty()) {
        rdn_string += "+";
      }
      std::string atv_string;
      if (!atv.AsRFC2253String(&atv_string)) {
        return false;
      }
      rdn_string += atv_string;
    }
    if (!rdns_string.empty()) {
      rdns_string += ",";
    }
    rdns_string += rdn_string;
  }

  *out = rdns_string;
  return true;
}

BSSL_NAMESPACE_END
