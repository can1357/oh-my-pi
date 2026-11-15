// Copyright 2010 The Chromium Authors
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

#include "pem.h"
#include "string_util.h"

#include <array>
#include <string_view>

namespace {

constexpr std::string_view kPEMHeaderBeginBlock = "-----BEGIN ";
constexpr std::string_view kPEMHeaderEndBlock = "-----END ";
constexpr std::string_view kPEMHeaderTail = "-----";

}  // namespace

BSSL_NAMESPACE_BEGIN



struct PEMTokenizer::PEMType {
  std::string type;
  std::string header;
  std::string footer;
};

PEMTokenizer::PEMTokenizer(
    std::string_view str, const std::vector<std::string> &allowed_block_types) {
  std::vector<std::string_view> types;
  for (const auto &type : allowed_block_types) {
    types.emplace_back(type);
  }
  Init(str, bssl::Span(types));
}

PEMTokenizer::PEMTokenizer(
    std::string_view str,
    bssl::Span<const std::string_view> allowed_block_types) {
  Init(str, allowed_block_types);
}

PEMTokenizer::~PEMTokenizer() = default;

bool PEMTokenizer::GetNext() {
  while (pos_ != std::string_view::npos) {
    // Scan for the beginning of the next PEM encoded block.
    pos_ = str_.find(kPEMHeaderBeginBlock, pos_);
    if (pos_ == std::string_view::npos) {
      return false;  // No more PEM blocks
    }

    std::vector<PEMType>::const_iterator it;
    // Check to see if it is of an acceptable block type.
    for (it = block_types_.begin(); it != block_types_.end(); ++it) {
      if (!bssl::string_util::StartsWith(str_.substr(pos_), it->header)) {
        continue;
      }

      // Look for a footer matching the header. If none is found, then all
      // data following this point is invalid and should not be parsed.
      std::string_view::size_type footer_pos = str_.find(it->footer, pos_);
      if (footer_pos == std::string_view::npos) {
        pos_ = std::string_view::npos;
        return false;
      }

      // Chop off the header and footer and parse the data in between.
      std::string_view::size_type data_begin = pos_ + it->header.size();
      pos_ = footer_pos + it->footer.size();
      block_type_ = it->type;

      std::string_view encoded =
          str_.substr(data_begin, footer_pos - data_begin);
      if (!string_util::Base64Decode(
              string_util::CollapseWhitespaceASCII(encoded, true), &data_)) {
        // The most likely cause for a decode failure is a datatype that
        // includes PEM headers, which are not supported.
        break;
      }

      return true;
    }

    // If the block did not match any acceptable type, move past it and
    // continue the search. Otherwise, |pos_| has been updated to the most
    // appropriate search position to continue searching from and should not
    // be adjusted.
    if (it == block_types_.end()) {
      pos_ += kPEMHeaderBeginBlock.size();
    }
  }

  return false;
}

void PEMTokenizer::Init(std::string_view str,
                        bssl::Span<const std::string_view> allowed_block_types) {
  str_ = str;
  pos_ = 0;

  // Construct PEM header/footer strings for all the accepted types, to
  // reduce parsing later.
  for (const auto &allowed_block_type : allowed_block_types) {
    PEMType allowed_type;
    allowed_type.type = allowed_block_type;
    allowed_type.header = kPEMHeaderBeginBlock;
    allowed_type.header.append(allowed_block_type);
    allowed_type.header.append(kPEMHeaderTail);
    allowed_type.footer = kPEMHeaderEndBlock;
    allowed_type.footer.append(allowed_block_type);
    allowed_type.footer.append(kPEMHeaderTail);
    block_types_.push_back(allowed_type);
  }
}

std::vector<PEMToken> PEMDecode(
    std::string_view data, bssl::Span<const std::string_view> allowed_types) {
  std::vector<PEMToken> results;
  PEMTokenizer tokenizer(data, allowed_types);
  while (tokenizer.GetNext()) {
    results.push_back(PEMToken{tokenizer.block_type(), tokenizer.data()});
  }
  return results;
}

std::optional<std::string> PEMDecodeSingle(
    std::string_view data, std::string_view allowed_type) {
  const std::array<const std::string_view, 1> allowed_types = {allowed_type};
  PEMTokenizer tokenizer(data, allowed_types);
  if (!tokenizer.GetNext()) {
    return std::nullopt;
  }

  std::string result = tokenizer.data();

  // We need exactly one token of the allowed types, so return nullopt if
  // there's more than one.
  if (tokenizer.GetNext()) {
    return std::nullopt;
  }

  return result;
}

std::string PEMEncode(std::string_view data, const std::string &type) {
  std::string b64_encoded;
  string_util::Base64Encode(data, &b64_encoded);

  // Divide the Base-64 encoded data into 64-character chunks, as per
  // 4.3.2.4 of RFC 1421.
  static const size_t kChunkSize = 64;
  size_t chunks = (b64_encoded.size() + (kChunkSize - 1)) / kChunkSize;

  std::string pem_encoded;
  pem_encoded.reserve(
      // header & footer
      17 + 15 + type.size() * 2 +
      // encoded data
      b64_encoded.size() +
      // newline characters for line wrapping in encoded data
      chunks);

  pem_encoded = kPEMHeaderBeginBlock;
  pem_encoded.append(type);
  pem_encoded.append(kPEMHeaderTail);
  pem_encoded.append("\n");

  for (size_t i = 0, chunk_offset = 0; i < chunks;
       ++i, chunk_offset += kChunkSize) {
    pem_encoded.append(b64_encoded, chunk_offset, kChunkSize);
    pem_encoded.append("\n");
  }

  pem_encoded.append(kPEMHeaderEndBlock);
  pem_encoded.append(type);
  pem_encoded.append(kPEMHeaderTail);
  pem_encoded.append("\n");
  return pem_encoded;
}

BSSL_NAMESPACE_END
