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

#include "parse_values.h"

#include <stdlib.h>

#include <tuple>

#include <openssl/base.h>
#include <openssl/bytestring.h>
#include <openssl/mem.h>

BSSL_NAMESPACE_BEGIN
namespace der {

namespace {

bool ParseBoolInternal(Input in, bool *out, bool relaxed) {
  // According to ITU-T X.690 section 8.2, a bool is encoded as a single octet
  // where the octet of all zeroes is FALSE and a non-zero value for the octet
  // is TRUE.
  if (in.size() != 1) {
    return false;
  }
  ByteReader data(in);
  uint8_t byte;
  if (!data.ReadByte(&byte)) {
    return false;
  }
  if (byte == 0) {
    *out = false;
    return true;
  }
  // ITU-T X.690 section 11.1 specifies that for DER, the TRUE value must be
  // encoded as an octet of all ones.
  if (byte == 0xff || relaxed) {
    *out = true;
    return true;
  }
  return false;
}

// Reads a positive decimal number with |digits| digits and stores it in
// |*out|. This function does not check that the type of |*out| is large
// enough to hold 10^digits - 1; the caller must choose an appropriate type
// based on the number of digits they wish to parse.
template <typename UINT>
bool DecimalStringToUint(ByteReader &in, size_t digits, UINT *out) {
  UINT value = 0;
  for (size_t i = 0; i < digits; ++i) {
    uint8_t digit;
    if (!in.ReadByte(&digit)) {
      return false;
    }
    if (digit < '0' || digit > '9') {
      return false;
    }
    value = (value * 10) + (digit - '0');
  }
  *out = value;
  return true;
}

// Checks that the values in a GeneralizedTime struct are valid. This involves
// checking that the year is 4 digits, the month is between 1 and 12, the day
// is a day that exists in that month (following current leap year rules),
// hours are between 0 and 23, minutes between 0 and 59, and seconds between
// 0 and 60 (to allow for leap seconds; no validation is done that a leap
// second is on a day that could be a leap second).
bool ValidateGeneralizedTime(const GeneralizedTime &time) {
  if (time.month < 1 || time.month > 12) {
    return false;
  }
  if (time.day < 1) {
    return false;
  }
  if (time.hours > 23) {
    return false;
  }
  if (time.minutes > 59) {
    return false;
  }
  // Leap seconds are allowed.
  if (time.seconds > 60) {
    return false;
  }

  // validate upper bound for day of month
  switch (time.month) {
    case 4:
    case 6:
    case 9:
    case 11:
      if (time.day > 30) {
        return false;
      }
      break;
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      if (time.day > 31) {
        return false;
      }
      break;
    case 2:
      if (time.year % 4 == 0 &&
          (time.year % 100 != 0 || time.year % 400 == 0)) {
        if (time.day > 29) {
          return false;
        }
      } else {
        if (time.day > 28) {
          return false;
        }
      }
      break;
    default:
      abort();
  }
  return true;
}

// Returns the number of bytes of numeric precision in a DER encoded INTEGER
// value. |in| must be a valid DER encoding of an INTEGER for this to work.
//
// Normally the precision of the number is exactly in.size(). However when
// encoding positive numbers using DER it is possible to have a leading zero
// (to prevent number from being interpreted as negative).
//
// For instance a 160-bit positive number might take 21 bytes to encode. This
// function will return 20 in such a case.
size_t GetUnsignedIntegerLength(Input in) {
  der::ByteReader reader(in);
  uint8_t first_byte;
  if (!reader.ReadByte(&first_byte)) {
    return 0;  // Not valid DER  as |in| was empty.
  }

  if (first_byte == 0 && in.size() > 1) {
    return in.size() - 1;
  }
  return in.size();
}

}  // namespace

bool ParseBool(Input in, bool *out) {
  return ParseBoolInternal(in, out, false /* relaxed */);
}

// BER interprets any non-zero value as true, while DER requires a bool to
// have either all bits zero (false) or all bits one (true). To support
// malformed certs, we recognized the BER encoding instead of failing to
// parse.
bool ParseBoolRelaxed(Input in, bool *out) {
  return ParseBoolInternal(in, out, true /* relaxed */);
}

// ITU-T X.690 section 8.3.2 specifies that an integer value must be encoded
// in the smallest number of octets. If the encoding consists of more than
// one octet, then the bits of the first octet and the most significant bit
// of the second octet must not be all zeroes or all ones.
bool IsValidInteger(Input in, bool *negative) {
  CBS cbs;
  CBS_init(&cbs, in.data(), in.size());
  int negative_int;
  if (!CBS_is_valid_asn1_integer(&cbs, &negative_int)) {
    return false;
  }

  *negative = !!negative_int;
  return true;
}

bool ParseUint64(Input in, uint64_t *out) {
  // Reject non-minimally encoded numbers and negative numbers.
  bool negative;
  if (!IsValidInteger(in, &negative) || negative) {
    return false;
  }

  // Reject (non-negative) integers whose value would overflow the output type.
  if (GetUnsignedIntegerLength(in) > sizeof(*out)) {
    return false;
  }

  ByteReader reader(in);
  uint8_t data;
  uint64_t value = 0;

  while (reader.ReadByte(&data)) {
    value <<= 8;
    value |= data;
  }
  *out = value;
  return true;
}

bool ParseUint8(Input in, uint8_t *out) {
  // TODO(eroman): Implement this more directly.
  uint64_t value;
  if (!ParseUint64(in, &value)) {
    return false;
  }

  if (value > 0xFF) {
    return false;
  }

  *out = static_cast<uint8_t>(value);
  return true;
}

BitString::BitString(Input bytes, uint8_t unused_bits)
    : bytes_(bytes), unused_bits_(unused_bits) {
  BSSL_CHECK(unused_bits < 8);
  BSSL_CHECK(unused_bits == 0 || !bytes.empty());
  // The unused bits must be zero.
  BSSL_CHECK(bytes.empty() || (bytes.back() & ((1u << unused_bits) - 1)) == 0);
}

bool BitString::AssertsBit(size_t bit_index) const {
  // Index of the byte that contains the bit.
  size_t byte_index = bit_index / 8;

  // If the bit is outside of the bitstring, by definition it is not
  // asserted.
  if (byte_index >= bytes_.size()) {
    return false;
  }

  // Within a byte, bits are ordered from most significant to least significant.
  // Convert |bit_index| to an index within the |byte_index| byte, measured from
  // its least significant bit.
  uint8_t bit_index_in_byte = 7 - (bit_index - byte_index * 8);

  // BIT STRING parsing already guarantees that unused bits in a byte are zero
  // (otherwise it wouldn't be valid DER). Therefore it isn't necessary to check
  // |unused_bits_|
  uint8_t byte = bytes_[byte_index];
  return 0 != (byte & (1 << bit_index_in_byte));
}

std::optional<BitString> ParseBitString(Input in) {
  ByteReader reader(in);

  // From ITU-T X.690, section 8.6.2.2 (applies to BER, CER, DER):
  //
  // The initial octet shall encode, as an unsigned binary integer with
  // bit 1 as the least significant bit, the number of unused bits in the final
  // subsequent octet. The number shall be in the range zero to seven.
  uint8_t unused_bits;
  if (!reader.ReadByte(&unused_bits)) {
    return std::nullopt;
  }
  if (unused_bits > 7) {
    return std::nullopt;
  }

  Input bytes;
  if (!reader.ReadBytes(reader.BytesLeft(), &bytes)) {
    return std::nullopt;  // Not reachable.
  }

  // Ensure that unused bits in the last byte are set to 0.
  if (unused_bits > 0) {
    // From ITU-T X.690, section 8.6.2.3 (applies to BER, CER, DER):
    //
    // If the bitstring is empty, there shall be no subsequent octets,
    // and the initial octet shall be zero.
    if (bytes.empty()) {
      return std::nullopt;
    }
    uint8_t last_byte = bytes.back();

    // From ITU-T X.690, section 11.2.1 (applies to CER and DER, but not BER):
    //
    // Each unused bit in the final octet of the encoding of a bit string value
    // shall be set to zero.
    uint8_t mask = 0xFF >> (8 - unused_bits);
    if ((mask & last_byte) != 0) {
      return std::nullopt;
    }
  }

  return BitString(bytes, unused_bits);
}

bool GeneralizedTime::InUTCTimeRange() const {
  return 1950 <= year && year < 2050;
}

bool operator<(const GeneralizedTime &lhs, const GeneralizedTime &rhs) {
  return std::tie(lhs.year, lhs.month, lhs.day, lhs.hours, lhs.minutes,
                  lhs.seconds) < std::tie(rhs.year, rhs.month, rhs.day,
                                          rhs.hours, rhs.minutes, rhs.seconds);
}

bool operator>(const GeneralizedTime &lhs, const GeneralizedTime &rhs) {
  return rhs < lhs;
}

bool operator<=(const GeneralizedTime &lhs, const GeneralizedTime &rhs) {
  return !(lhs > rhs);
}

bool operator>=(const GeneralizedTime &lhs, const GeneralizedTime &rhs) {
  return !(lhs < rhs);
}

bool ParseUTCTime(Input in, GeneralizedTime *value) {
  ByteReader reader(in);
  GeneralizedTime time;
  if (!DecimalStringToUint(reader, 2, &time.year) ||
      !DecimalStringToUint(reader, 2, &time.month) ||
      !DecimalStringToUint(reader, 2, &time.day) ||
      !DecimalStringToUint(reader, 2, &time.hours) ||
      !DecimalStringToUint(reader, 2, &time.minutes) ||
      !DecimalStringToUint(reader, 2, &time.seconds)) {
    return false;
  }
  uint8_t zulu;
  if (!reader.ReadByte(&zulu) || zulu != 'Z' || reader.HasMore()) {
    return false;
  }
  if (time.year < 50) {
    time.year += 2000;
  } else {
    time.year += 1900;
  }
  if (!ValidateGeneralizedTime(time)) {
    return false;
  }
  *value = time;
  return true;
}

bool ParseGeneralizedTime(Input in, GeneralizedTime *value) {
  ByteReader reader(in);
  GeneralizedTime time;
  if (!DecimalStringToUint(reader, 4, &time.year) ||
      !DecimalStringToUint(reader, 2, &time.month) ||
      !DecimalStringToUint(reader, 2, &time.day) ||
      !DecimalStringToUint(reader, 2, &time.hours) ||
      !DecimalStringToUint(reader, 2, &time.minutes) ||
      !DecimalStringToUint(reader, 2, &time.seconds)) {
    return false;
  }
  uint8_t zulu;
  if (!reader.ReadByte(&zulu) || zulu != 'Z' || reader.HasMore()) {
    return false;
  }
  if (!ValidateGeneralizedTime(time)) {
    return false;
  }
  *value = time;
  return true;
}

bool ParseIA5String(Input in, std::string *out) {
  for (uint8_t c : in) {
    if (c > 127) {
      return false;
    }
  }
  *out = BytesAsStringView(in);
  return true;
}

bool ParseVisibleString(Input in, std::string *out) {
  // ITU-T X.680:
  // VisibleString : "Defining registration number 6" + SPACE
  // 6 includes all the characters from '!' .. '~' (33 .. 126), space is 32.
  // Also ITU-T X.691 says it much more clearly:
  // "for VisibleString [the range] is 32 to 126 ... For VisibleString .. all
  // the values in the range are present."
  for (uint8_t c : in) {
    if (c < 32 || c > 126) {
      return false;
    }
  }
  *out = BytesAsStringView(in);
  return true;
}

bool ParsePrintableString(Input in, std::string *out) {
  for (uint8_t c : in) {
    if (!(OPENSSL_isalpha(c) || c == ' ' || (c >= '\'' && c <= ':') ||
          c == '=' || c == '?')) {
      return false;
    }
  }
  *out = BytesAsStringView(in);
  return true;
}

bool ParseTeletexStringAsLatin1(Input in, std::string *out) {
  out->clear();
  // Convert from Latin-1 to UTF-8.
  size_t utf8_length = in.size();
  for (size_t i = 0; i < in.size(); i++) {
    if (in[i] > 0x7f) {
      utf8_length++;
    }
  }
  out->reserve(utf8_length);
  for (size_t i = 0; i < in.size(); i++) {
    uint8_t u = in[i];
    if (u <= 0x7f) {
      out->push_back(u);
    } else {
      out->push_back(0xc0 | (u >> 6));
      out->push_back(0x80 | (u & 0x3f));
    }
  }
  BSSL_CHECK(utf8_length == out->size());
  return true;
}

bool ParseUniversalString(Input in, std::string *out) {
  if (in.size() % 4 != 0) {
    return false;
  }

  CBS cbs;
  CBS_init(&cbs, in.data(), in.size());
  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), in.size())) {
    return false;
  }

  while (CBS_len(&cbs) != 0) {
    uint32_t c;
    if (!CBS_get_utf32_be(&cbs, &c) ||  //
        !CBB_add_utf8(cbb.get(), c)) {
      return false;
    }
  }

  out->assign(CBB_data(cbb.get()), CBB_data(cbb.get()) + CBB_len(cbb.get()));
  return true;
}

bool ParseBmpString(Input in, std::string *out) {
  if (in.size() % 2 != 0) {
    return false;
  }

  CBS cbs;
  CBS_init(&cbs, in.data(), in.size());
  bssl::ScopedCBB cbb;
  if (!CBB_init(cbb.get(), in.size())) {
    return false;
  }

  while (CBS_len(&cbs) != 0) {
    uint32_t c;
    if (!CBS_get_ucs2_be(&cbs, &c) ||  //
        !CBB_add_utf8(cbb.get(), c)) {
      return false;
    }
  }

  out->assign(CBB_data(cbb.get()), CBB_data(cbb.get()) + CBB_len(cbb.get()));
  return true;
}

}  // namespace der
BSSL_NAMESPACE_END
