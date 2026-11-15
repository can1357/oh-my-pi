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

#include "input.h"

BSSL_NAMESPACE_BEGIN
namespace der {

std::string Input::AsString() const { return std::string(AsStringView()); }

bool operator==(Input lhs, Input rhs) { return Span(lhs) == Span(rhs); }

bool operator!=(Input lhs, Input rhs) { return !(lhs == rhs); }

ByteReader::ByteReader(Input in) : data_(in) {}

bool ByteReader::ReadByte(uint8_t *byte_p) {
  if (!HasMore()) {
    return false;
  }
  *byte_p = data_[0];
  Advance(1);
  return true;
}

bool ByteReader::ReadBytes(size_t len, Input *out) {
  if (len > data_.size()) {
    return false;
  }
  *out = Input(data_.first(len));
  Advance(len);
  return true;
}

// Returns whether there is any more data to be read.
bool ByteReader::HasMore() { return !data_.empty(); }

void ByteReader::Advance(size_t len) {
  BSSL_CHECK(len <= data_.size());
  data_ = data_.subspan(len);
}

}  // namespace der
BSSL_NAMESPACE_END
