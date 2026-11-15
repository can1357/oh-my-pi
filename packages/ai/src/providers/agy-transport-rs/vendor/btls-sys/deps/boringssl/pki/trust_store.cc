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

#include <cassert>

#include "trust_store.h"

#include "string_util.h"

BSSL_NAMESPACE_BEGIN

namespace {

constexpr char kUnspecifiedStr[] = "UNSPECIFIED";
constexpr char kDistrustedStr[] = "DISTRUSTED";
constexpr char kTrustedAnchorStr[] = "TRUSTED_ANCHOR";
constexpr char kTrustedAnchorOrLeafStr[] = "TRUSTED_ANCHOR_OR_LEAF";
constexpr char kTrustedLeafStr[] = "TRUSTED_LEAF";

constexpr char kEnforceAnchorExpiry[] = "enforce_anchor_expiry";
constexpr char kEnforceAnchorConstraints[] = "enforce_anchor_constraints";
constexpr char kRequireAnchorBasicConstraints[] =
    "require_anchor_basic_constraints";
constexpr char kRequireLeafSelfsigned[] = "require_leaf_selfsigned";

}  // namespace

bool CertificateTrust::IsTrustAnchor() const {
  switch (type) {
    case CertificateTrustType::DISTRUSTED:
    case CertificateTrustType::UNSPECIFIED:
    case CertificateTrustType::TRUSTED_LEAF:
      return false;
    case CertificateTrustType::TRUSTED_ANCHOR:
    case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
      return true;
  }

  assert(0);  // NOTREACHED
  return false;
}

bool CertificateTrust::IsTrustLeaf() const {
  switch (type) {
    case CertificateTrustType::TRUSTED_LEAF:
    case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
      return true;
    case CertificateTrustType::DISTRUSTED:
    case CertificateTrustType::UNSPECIFIED:
    case CertificateTrustType::TRUSTED_ANCHOR:
      return false;
  }

  assert(0);  // NOTREACHED
  return false;
}

bool CertificateTrust::IsDistrusted() const {
  switch (type) {
    case CertificateTrustType::DISTRUSTED:
      return true;
    case CertificateTrustType::UNSPECIFIED:
    case CertificateTrustType::TRUSTED_ANCHOR:
    case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
    case CertificateTrustType::TRUSTED_LEAF:
      return false;
  }

  assert(0);  // NOTREACHED
  return false;
}

bool CertificateTrust::HasUnspecifiedTrust() const {
  switch (type) {
    case CertificateTrustType::UNSPECIFIED:
      return true;
    case CertificateTrustType::DISTRUSTED:
    case CertificateTrustType::TRUSTED_ANCHOR:
    case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
    case CertificateTrustType::TRUSTED_LEAF:
      return false;
  }

  assert(0);  // NOTREACHED
  return true;
}

std::string CertificateTrust::ToDebugString() const {
  std::string result;
  switch (type) {
    case CertificateTrustType::UNSPECIFIED:
      result = kUnspecifiedStr;
      break;
    case CertificateTrustType::DISTRUSTED:
      result = kDistrustedStr;
      break;
    case CertificateTrustType::TRUSTED_ANCHOR:
      result = kTrustedAnchorStr;
      break;
    case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
      result = kTrustedAnchorOrLeafStr;
      break;
    case CertificateTrustType::TRUSTED_LEAF:
      result = kTrustedLeafStr;
      break;
  }
  if (enforce_anchor_expiry) {
    result += '+';
    result += kEnforceAnchorExpiry;
  }
  if (enforce_anchor_constraints) {
    result += '+';
    result += kEnforceAnchorConstraints;
  }
  if (require_anchor_basic_constraints) {
    result += '+';
    result += kRequireAnchorBasicConstraints;
  }
  if (require_leaf_selfsigned) {
    result += '+';
    result += kRequireLeafSelfsigned;
  }
  return result;
}

// static
std::optional<CertificateTrust> CertificateTrust::FromDebugString(
    const std::string &trust_string) {
  std::vector<std::string_view> split =
      string_util::SplitString(trust_string, '+');

  if (split.empty()) {
    return std::nullopt;
  }

  CertificateTrust trust;

  if (string_util::IsEqualNoCase(split[0], kUnspecifiedStr)) {
    trust = CertificateTrust::ForUnspecified();
  } else if (string_util::IsEqualNoCase(split[0], kDistrustedStr)) {
    trust = CertificateTrust::ForDistrusted();
  } else if (string_util::IsEqualNoCase(split[0], kTrustedAnchorStr)) {
    trust = CertificateTrust::ForTrustAnchor();
  } else if (string_util::IsEqualNoCase(split[0], kTrustedAnchorOrLeafStr)) {
    trust = CertificateTrust::ForTrustAnchorOrLeaf();
  } else if (string_util::IsEqualNoCase(split[0], kTrustedLeafStr)) {
    trust = CertificateTrust::ForTrustedLeaf();
  } else {
    return std::nullopt;
  }

  for (auto i = ++split.begin(); i != split.end(); ++i) {
    if (string_util::IsEqualNoCase(*i, kEnforceAnchorExpiry)) {
      trust = trust.WithEnforceAnchorExpiry();
    } else if (string_util::IsEqualNoCase(*i, kEnforceAnchorConstraints)) {
      trust = trust.WithEnforceAnchorConstraints();
    } else if (string_util::IsEqualNoCase(*i, kRequireAnchorBasicConstraints)) {
      trust = trust.WithRequireAnchorBasicConstraints();
    } else if (string_util::IsEqualNoCase(*i, kRequireLeafSelfsigned)) {
      trust = trust.WithRequireLeafSelfSigned();
    } else {
      return std::nullopt;
    }
  }

  return trust;
}

TrustStore::TrustStore() = default;

void TrustStore::AsyncGetIssuersOf(const ParsedCertificate *cert,
                                   std::unique_ptr<Request> *out_req) {
  out_req->reset();
}

BSSL_NAMESPACE_END
