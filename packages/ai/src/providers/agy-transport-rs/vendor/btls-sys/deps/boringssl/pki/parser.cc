// Copyright 2015 The Chromium Authors
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

#include "parser.h"

#include "parse_values.h"

BSSL_NAMESPACE_BEGIN
namespace der {

Parser::Parser() { CBS_init(&cbs_, nullptr, 0); }

Parser::Parser(Input input) { CBS_init(&cbs_, input.data(), input.size()); }

bool Parser::PeekTagAndValue(CBS_ASN1_TAG *tag, Input *out) {
  CBS peeker = cbs_;
  CBS tmp_out;
  size_t header_len;
  CBS_ASN1_TAG tag_value;
  if (!CBS_get_any_asn1_element(&peeker, &tmp_out, &tag_value, &header_len) ||
      !CBS_skip(&tmp_out, header_len)) {
    return false;
  }
  advance_len_ = CBS_len(&tmp_out) + header_len;
  *tag = tag_value;
  *out = Input(CBS_data(&tmp_out), CBS_len(&tmp_out));
  return true;
}

bool Parser::Advance() {
  if (advance_len_ == 0) {
    return false;
  }
  bool ret = !!CBS_skip(&cbs_, advance_len_);
  advance_len_ = 0;
  return ret;
}

bool Parser::HasMore() { return CBS_len(&cbs_) > 0; }

bool Parser::ReadRawTLV(Input *out) {
  CBS tmp_out;
  if (!CBS_get_any_asn1_element(&cbs_, &tmp_out, nullptr, nullptr)) {
    return false;
  }
  *out = Input(CBS_data(&tmp_out), CBS_len(&tmp_out));
  return true;
}

bool Parser::ReadTagAndValue(CBS_ASN1_TAG *tag, Input *out) {
  if (!PeekTagAndValue(tag, out)) {
    return false;
  }
  BSSL_CHECK(Advance());
  return true;
}

bool Parser::ReadOptionalTag(CBS_ASN1_TAG tag, std::optional<Input> *out) {
  if (!HasMore()) {
    *out = std::nullopt;
    return true;
  }
  CBS_ASN1_TAG actual_tag;
  Input value;
  if (!PeekTagAndValue(&actual_tag, &value)) {
    return false;
  }
  if (actual_tag == tag) {
    BSSL_CHECK(Advance());
    *out = value;
  } else {
    advance_len_ = 0;
    *out = std::nullopt;
  }
  return true;
}

bool Parser::ReadOptionalTag(CBS_ASN1_TAG tag, Input *out, bool *present) {
  std::optional<Input> tmp_out;
  if (!ReadOptionalTag(tag, &tmp_out)) {
    return false;
  }
  *present = tmp_out.has_value();
  *out = tmp_out.value_or(der::Input());
  return true;
}

bool Parser::SkipOptionalTag(CBS_ASN1_TAG tag, bool *present) {
  Input out;
  return ReadOptionalTag(tag, &out, present);
}

bool Parser::ReadTag(CBS_ASN1_TAG tag, Input *out) {
  CBS_ASN1_TAG actual_tag;
  Input value;
  if (!PeekTagAndValue(&actual_tag, &value) || actual_tag != tag) {
    return false;
  }
  BSSL_CHECK(Advance());
  *out = value;
  return true;
}

bool Parser::SkipTag(CBS_ASN1_TAG tag) {
  Input out;
  return ReadTag(tag, &out);
}

// Type-specific variants of ReadTag

bool Parser::ReadConstructed(CBS_ASN1_TAG tag, Parser *out) {
  if (!(tag & CBS_ASN1_CONSTRUCTED)) {
    return false;
  }
  Input data;
  if (!ReadTag(tag, &data)) {
    return false;
  }
  *out = Parser(data);
  return true;
}

bool Parser::ReadSequence(Parser *out) {
  return ReadConstructed(CBS_ASN1_SEQUENCE, out);
}

bool Parser::ReadUint8(uint8_t *out) {
  Input encoded_int;
  if (!ReadTag(CBS_ASN1_INTEGER, &encoded_int)) {
    return false;
  }
  return ParseUint8(encoded_int, out);
}

bool Parser::ReadUint64(uint64_t *out) {
  Input encoded_int;
  if (!ReadTag(CBS_ASN1_INTEGER, &encoded_int)) {
    return false;
  }
  return ParseUint64(encoded_int, out);
}

std::optional<BitString> Parser::ReadBitString() {
  Input value;
  if (!ReadTag(CBS_ASN1_BITSTRING, &value)) {
    return std::nullopt;
  }
  return ParseBitString(value);
}

bool Parser::ReadGeneralizedTime(GeneralizedTime *out) {
  Input value;
  if (!ReadTag(CBS_ASN1_GENERALIZEDTIME, &value)) {
    return false;
  }
  return ParseGeneralizedTime(value, out);
}

}  // namespace der
BSSL_NAMESPACE_END
