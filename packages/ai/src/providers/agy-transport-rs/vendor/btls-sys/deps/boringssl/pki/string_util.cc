// Copyright 2022 The Chromium Authors
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

#include "string_util.h"

#include <algorithm>
#include <iomanip>
#include <sstream>
#include <string>

#include <openssl/base64.h>
#include <openssl/mem.h>

BSSL_NAMESPACE_BEGIN
namespace string_util {

bool IsAscii(std::string_view str) {
  for (unsigned char c : str) {
    if (c > 127) {
      return false;
    }
  }
  return true;
}

bool IsEqualNoCase(std::string_view str1, std::string_view str2) {
  return std::equal(str1.begin(), str1.end(), str2.begin(), str2.end(),
                    [](const unsigned char a, const unsigned char b) {
                      return OPENSSL_tolower(a) == OPENSSL_tolower(b);
                    });
}

bool EndsWithNoCase(std::string_view str, std::string_view suffix) {
  return suffix.size() <= str.size() &&
         IsEqualNoCase(suffix, str.substr(str.size() - suffix.size()));
}

bool StartsWithNoCase(std::string_view str, std::string_view prefix) {
  return prefix.size() <= str.size() &&
         IsEqualNoCase(prefix, str.substr(0, prefix.size()));
}

std::string FindAndReplace(std::string_view str, std::string_view find,
                           std::string_view replace) {
  std::string ret;

  if (find.empty()) {
    return std::string(str);
  }
  while (!str.empty()) {
    size_t index = str.find(find);
    if (index == std::string_view::npos) {
      ret.append(str);
      break;
    }
    ret.append(str.substr(0, index));
    ret.append(replace);
    str = str.substr(index + find.size());
  }
  return ret;
}

// TODO(bbe) get rid of this once we can c++20.
bool EndsWith(std::string_view str, std::string_view suffix) {
  return suffix.size() <= str.size() &&
         suffix == str.substr(str.size() - suffix.size());
}

// TODO(bbe) get rid of this once we can c++20.
bool StartsWith(std::string_view str, std::string_view prefix) {
  return prefix.size() <= str.size() && prefix == str.substr(0, prefix.size());
}

std::string HexEncode(Span<const uint8_t> data) {
  std::ostringstream out;
  for (uint8_t b : data) {
    out << std::hex << std::setfill('0') << std::setw(2) << std::uppercase
        << int{b};
  }
  return out.str();
}

// TODO(bbe) get rid of this once extracted to boringssl. Everything else
// in third_party uses std::to_string
std::string NumberToDecimalString(int i) {
  std::ostringstream out;
  out << std::dec << i;
  return out.str();
}

std::vector<std::string_view> SplitString(std::string_view str,
                                          char split_char) {
  std::vector<std::string_view> out;

  if (str.empty()) {
    return out;
  }

  while (true) {
    // Find end of current token
    size_t i = str.find(split_char);

    // Add current token
    out.push_back(str.substr(0, i));

    if (i == str.npos) {
      // That was the last token
      break;
    }
    // Continue to next
    str = str.substr(i + 1);
  }

  return out;
}

static bool IsUnicodeWhitespace(char c) {
  return c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == ' ';
}

std::string CollapseWhitespaceASCII(std::string_view text,
                                    bool trim_sequences_with_line_breaks) {
  std::string result;
  result.resize(text.size());

  // Set flags to pretend we're already in a trimmed whitespace sequence, so we
  // will trim any leading whitespace.
  bool in_whitespace = true;
  bool already_trimmed = true;

  int chars_written = 0;
  for (auto i = text.begin(); i != text.end(); ++i) {
    if (IsUnicodeWhitespace(*i)) {
      if (!in_whitespace) {
        // Reduce all whitespace sequences to a single space.
        in_whitespace = true;
        result[chars_written++] = L' ';
      }
      if (trim_sequences_with_line_breaks && !already_trimmed &&
          ((*i == '\n') || (*i == '\r'))) {
        // Whitespace sequences containing CR or LF are eliminated entirely.
        already_trimmed = true;
        --chars_written;
      }
    } else {
      // Non-whitespace characters are copied straight across.
      in_whitespace = false;
      already_trimmed = false;
      result[chars_written++] = *i;
    }
  }

  if (in_whitespace && !already_trimmed) {
    // Any trailing whitespace is eliminated.
    --chars_written;
  }

  result.resize(chars_written);
  return result;
}

bool Base64Encode(const std::string_view &input, std::string *output) {
  size_t len;
  if (!EVP_EncodedLength(&len, input.size())) {
    return false;
  }
  std::vector<char> encoded(len);
  len = EVP_EncodeBlock(reinterpret_cast<uint8_t *>(encoded.data()),
                        reinterpret_cast<const uint8_t *>(input.data()),
                        input.size());
  if (!len) {
    return false;
  }
  output->assign(encoded.data(), len);
  return true;
}

bool Base64Decode(const std::string_view &input, std::string *output) {
  size_t len;
  if (!EVP_DecodedLength(&len, input.size())) {
    return false;
  }
  std::vector<char> decoded(len);
  if (!EVP_DecodeBase64(reinterpret_cast<uint8_t *>(decoded.data()), &len, len,
                        reinterpret_cast<const uint8_t *>(input.data()),
                        input.size())) {
    return false;
  }
  output->assign(decoded.data(), len);
  return true;
}

}  // namespace string_util
BSSL_NAMESPACE_END
