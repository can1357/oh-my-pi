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

#include "path_builder.h"

#include <cassert>
#include <memory>
#include <set>
#include <unordered_set>

#include <openssl/base.h>
#include <openssl/pki/verify_error.h>
#include <openssl/sha2.h>

#include "cert_issuer_source.h"
#include "certificate_policies.h"
#include "common_cert_errors.h"
#include "parse_certificate.h"
#include "parse_name.h"  // For CertDebugString.
#include "parser.h"
#include "string_util.h"
#include "trust_store.h"
#include "verify_certificate_chain.h"
#include "verify_name_match.h"

BSSL_NAMESPACE_BEGIN

namespace {

using CertIssuerSources = std::vector<CertIssuerSource *>;

// Returns a hex-encoded sha256 of the DER-encoding of |cert|.
std::string FingerPrintParsedCertificate(const bssl::ParsedCertificate *cert) {
  uint8_t digest[SHA256_DIGEST_LENGTH];
  SHA256(cert->der_cert().data(), cert->der_cert().size(), digest);
  return bssl::string_util::HexEncode(digest);
}

// TODO(mattm): decide how much debug logging to keep.
std::string CertDebugString(const ParsedCertificate *cert) {
  RDNSequence subject;
  std::string subject_str;
  if (!ParseName(cert->tbs().subject_tlv, &subject) ||
      !ConvertToRFC2253(subject, &subject_str)) {
    subject_str = "???";
  }

  return FingerPrintParsedCertificate(cert) + " " + subject_str;
}

std::string PathDebugString(const ParsedCertificateList &certs) {
  std::string s;
  for (const auto &cert : certs) {
    if (!s.empty()) {
      s += "\n";
    }
    s += " " + CertDebugString(cert.get());
  }
  return s;
}

// This structure describes a certificate and its trust level. Note that |cert|
// may be null to indicate an "empty" entry.
struct IssuerEntry {
  std::shared_ptr<const ParsedCertificate> cert;
  CertificateTrust trust;
  int trust_and_key_id_match_ordering;
};

enum KeyIdentifierMatch {
  // |target| has a keyIdentifier and it matches |issuer|'s
  // subjectKeyIdentifier.
  kMatch = 0,
  // |target| does not have authorityKeyIdentifier or |issuer| does not have
  // subjectKeyIdentifier.
  kNoData = 1,
  // |target|'s authorityKeyIdentifier does not match |issuer|.
  kMismatch = 2,
};

// Returns an integer that represents the relative ordering of |issuer| for
// prioritizing certificates in path building based on |issuer|'s
// subjectKeyIdentifier and |target|'s authorityKeyIdentifier. Lower return
// values indicate higher priority.
KeyIdentifierMatch CalculateKeyIdentifierMatch(
    const ParsedCertificate *target, const ParsedCertificate *issuer) {
  if (!target->authority_key_identifier()) {
    return kNoData;
  }

  // TODO(crbug.com/635205): If issuer does not have a subjectKeyIdentifier,
  // could try synthesizing one using the standard SHA-1 method. Ideally in a
  // way where any issuers that do have a matching subjectKeyIdentifier could
  // be tried first before doing the extra work.
  if (target->authority_key_identifier()->key_identifier &&
      issuer->subject_key_identifier()) {
    if (target->authority_key_identifier()->key_identifier !=
        issuer->subject_key_identifier().value()) {
      return kMismatch;
    }
    return kMatch;
  }

  return kNoData;
}

// Returns an integer that represents the relative ordering of |issuer| based
// on |issuer_trust| and authorityKeyIdentifier matching for prioritizing
// certificates in path building. Lower return values indicate higher priority.
int TrustAndKeyIdentifierMatchToOrder(const ParsedCertificate *target,
                                      const ParsedCertificate *issuer,
                                      const CertificateTrust &issuer_trust) {
  enum {
    kTrustedAndKeyIdMatch = 0,
    kTrustedAndKeyIdNoData = 1,
    kKeyIdMatch = 2,
    kKeyIdNoData = 3,
    kTrustedAndKeyIdMismatch = 4,
    kKeyIdMismatch = 5,
    kDistrustedAndKeyIdMatch = 6,
    kDistrustedAndKeyIdNoData = 7,
    kDistrustedAndKeyIdMismatch = 8,
  };

  KeyIdentifierMatch key_id_match = CalculateKeyIdentifierMatch(target, issuer);
  switch (issuer_trust.type) {
    case CertificateTrustType::TRUSTED_ANCHOR:
    case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
      switch (key_id_match) {
        case kMatch:
          return kTrustedAndKeyIdMatch;
        case kNoData:
          return kTrustedAndKeyIdNoData;
        case kMismatch:
          return kTrustedAndKeyIdMismatch;
      }
      break;
    case CertificateTrustType::UNSPECIFIED:
    case CertificateTrustType::TRUSTED_LEAF:
      switch (key_id_match) {
        case kMatch:
          return kKeyIdMatch;
        case kNoData:
          return kKeyIdNoData;
        case kMismatch:
          return kKeyIdMismatch;
      }
      break;
    case CertificateTrustType::DISTRUSTED:
      switch (key_id_match) {
        case kMatch:
          return kDistrustedAndKeyIdMatch;
        case kNoData:
          return kDistrustedAndKeyIdNoData;
        case kMismatch:
          return kDistrustedAndKeyIdMismatch;
      }
      break;
  }
  assert(0);  // NOTREACHED
  return -1;
}

// CertIssuersIter iterates through the intermediates from |cert_issuer_sources|
// which may be issuers of |cert|.
class CertIssuersIter {
 public:
  // Constructs the CertIssuersIter. |*cert_issuer_sources|, and
  // |*trust_store| must be valid for the lifetime of the CertIssuersIter.
  CertIssuersIter(std::shared_ptr<const ParsedCertificate> cert,
                  CertIssuerSources *cert_issuer_sources,
                  TrustStore *trust_store);

  CertIssuersIter(const CertIssuersIter &) = delete;
  CertIssuersIter &operator=(const CertIssuersIter &) = delete;

  // Gets the next candidate issuer, or clears |*out| when all issuers have been
  // exhausted.
  void GetNextIssuer(IssuerEntry *out);

  // Returns true if candidate issuers were found for |cert_|.
  bool had_non_skipped_issuers() const {
    return issuers_.size() > skipped_issuer_count_;
  }

  void increment_skipped_issuer_count() { skipped_issuer_count_++; }

  // Returns the |cert| for which issuers are being retrieved.
  const ParsedCertificate *cert() const { return cert_.get(); }
  std::shared_ptr<const ParsedCertificate> reference_cert() const {
    return cert_;
  }

 private:
  void AddIssuers(ParsedCertificateList issuers);
  void DoAsyncIssuerQuery();

  // Returns true if |issuers_| contains unconsumed certificates.
  bool HasCurrentIssuer() const { return cur_issuer_ < issuers_.size(); }

  // Sorts the remaining entries in |issuers_| in the preferred order to
  // explore. Does not change the ordering for indices before cur_issuer_.
  void SortRemainingIssuers();

  std::shared_ptr<const ParsedCertificate> cert_;
  CertIssuerSources *cert_issuer_sources_;
  TrustStore *trust_store_;

  // The list of issuers for |cert_|. This is added to incrementally (first
  // synchronous results, then possibly multiple times as asynchronous results
  // arrive.) The issuers may be re-sorted each time new issuers are added, but
  // only the results from |cur_| onwards should be sorted, since the earlier
  // results were already returned.
  // Elements should not be removed from |issuers_| once added, since
  // |present_issuers_| will point to data owned by the certs.
  std::vector<IssuerEntry> issuers_;
  // The index of the next cert in |issuers_| to return.
  size_t cur_issuer_ = 0;
  // The number of issuers that were skipped due to the loop checker.
  size_t skipped_issuer_count_ = 0;
  // Set to true whenever new issuers are appended at the end, to indicate the
  // ordering needs to be checked.
  bool issuers_needs_sort_ = false;

  // Set of DER-encoded values for the certs in |issuers_|. Used to prevent
  // duplicates. This is based on the full DER of the cert to allow different
  // versions of the same certificate to be tried in different candidate paths.
  // This points to data owned by |issuers_|.
  std::unordered_set<std::string_view> present_issuers_;

  // Tracks which requests have been made yet.
  bool did_initial_query_ = false;
  bool did_async_issuer_query_ = false;
  // Index into pending_async_requests_ that is the next one to process.
  size_t cur_async_request_ = 0;
  // Owns the Request objects for any asynchronous requests so that they will be
  // cancelled if CertIssuersIter is destroyed.
  std::vector<std::unique_ptr<CertIssuerSource::Request>>
      pending_async_requests_;
};

CertIssuersIter::CertIssuersIter(
    std::shared_ptr<const ParsedCertificate> in_cert,
    CertIssuerSources *cert_issuer_sources, TrustStore *trust_store)
    : cert_(std::move(in_cert)),
      cert_issuer_sources_(cert_issuer_sources),
      trust_store_(trust_store) {}

void CertIssuersIter::GetNextIssuer(IssuerEntry *out) {
  if (!did_initial_query_) {
    did_initial_query_ = true;
    for (auto *cert_issuer_source : *cert_issuer_sources_) {
      ParsedCertificateList new_issuers;
      cert_issuer_source->SyncGetIssuersOf(cert(), &new_issuers);
      AddIssuers(std::move(new_issuers));
    }
  }

  // If there aren't any issuers, block until async results are ready.
  if (!HasCurrentIssuer()) {
    if (!did_async_issuer_query_) {
      // Now issue request(s) for async ones (AIA, etc).
      DoAsyncIssuerQuery();
    }

    // TODO(eroman): Rather than blocking on the async requests in FIFO order,
    // consume in the order they become ready.
    while (!HasCurrentIssuer() &&
           cur_async_request_ < pending_async_requests_.size()) {
      ParsedCertificateList new_issuers;
      pending_async_requests_[cur_async_request_]->GetNext(&new_issuers);
      if (new_issuers.empty()) {
        // Request is exhausted, no more results pending from that
        // CertIssuerSource.
        pending_async_requests_[cur_async_request_++].reset();
      } else {
        AddIssuers(std::move(new_issuers));
      }
    }
  }

  if (HasCurrentIssuer()) {
    SortRemainingIssuers();

    // Still have issuers that haven't been returned yet, return the highest
    // priority one (head of remaining list). A reference to the returned issuer
    // is retained, since |present_issuers_| points to data owned by it.
    *out = issuers_[cur_issuer_++];
    return;
  }

  // Reached the end of all available issuers.
  *out = IssuerEntry();
}

void CertIssuersIter::AddIssuers(ParsedCertificateList new_issuers) {
  for (std::shared_ptr<const ParsedCertificate> &issuer : new_issuers) {
    if (present_issuers_.find(BytesAsStringView(issuer->der_cert())) !=
        present_issuers_.end()) {
      continue;
    }
    present_issuers_.insert(BytesAsStringView(issuer->der_cert()));

    // Look up the trust for this issuer.
    IssuerEntry entry;
    entry.cert = std::move(issuer);
    entry.trust = trust_store_->GetTrust(entry.cert.get());
    entry.trust_and_key_id_match_ordering = TrustAndKeyIdentifierMatchToOrder(
        cert(), entry.cert.get(), entry.trust);

    issuers_.push_back(std::move(entry));
    issuers_needs_sort_ = true;
  }
}

void CertIssuersIter::DoAsyncIssuerQuery() {
  BSSL_CHECK(!did_async_issuer_query_);
  did_async_issuer_query_ = true;
  cur_async_request_ = 0;
  for (auto *cert_issuer_source : *cert_issuer_sources_) {
    std::unique_ptr<CertIssuerSource::Request> request;
    cert_issuer_source->AsyncGetIssuersOf(cert(), &request);
    if (request) {
      pending_async_requests_.push_back(std::move(request));
    }
  }
}

void CertIssuersIter::SortRemainingIssuers() {
  if (!issuers_needs_sort_) {
    return;
  }

  std::stable_sort(
      issuers_.begin() + cur_issuer_, issuers_.end(),
      [](const IssuerEntry &issuer1, const IssuerEntry &issuer2) {
        // TODO(crbug.com/635205): Add other prioritization hints. (See big list
        // of possible sorting hints in RFC 4158.)
        const bool issuer1_self_issued = issuer1.cert->normalized_subject() ==
                                         issuer1.cert->normalized_issuer();
        const bool issuer2_self_issued = issuer2.cert->normalized_subject() ==
                                         issuer2.cert->normalized_issuer();
        return std::tie(issuer1.trust_and_key_id_match_ordering,
                        issuer2_self_issued,
                        // Newer(larger) notBefore & notAfter dates are
                        // preferred, hence |issuer2| is on the LHS of
                        // the comparison and |issuer1| on the RHS.
                        issuer2.cert->tbs().validity_not_before,
                        issuer2.cert->tbs().validity_not_after) <
               std::tie(issuer2.trust_and_key_id_match_ordering,
                        issuer1_self_issued,
                        issuer1.cert->tbs().validity_not_before,
                        issuer1.cert->tbs().validity_not_after);
      });

  issuers_needs_sort_ = false;
}

// CertIssuerIterPath tracks which certs are present in the path and prevents
// paths from being built which repeat any certs (including different versions
// of the same cert, based on Subject+SubjectAltName+SPKI).
// (RFC 5280 forbids duplicate certificates per section 6.1, and RFC 4158
// further recommends disallowing the same Subject+SubjectAltName+SPKI in
// section 2.4.2.)
class CertIssuerIterPath {
 public:
  // Returns true if |cert| is already present in the path.
  bool IsPresent(const ParsedCertificate *cert) const {
    return present_certs_.find(GetKey(cert)) != present_certs_.end();
  }

  // Appends |cert_issuers_iter| to the path. The cert referred to by
  // |cert_issuers_iter| must not be present in the path already.
  void Append(std::unique_ptr<CertIssuersIter> cert_issuers_iter) {
    bool added =
        present_certs_.insert(GetKey(cert_issuers_iter->cert())).second;
    BSSL_CHECK(added);
    cur_path_.push_back(std::move(cert_issuers_iter));
  }

  // Pops the last CertIssuersIter off the path.
  void Pop() {
    size_t num_erased = present_certs_.erase(GetKey(cur_path_.back()->cert()));
    BSSL_CHECK(num_erased == 1U);
    cur_path_.pop_back();
  }

  // Copies the ParsedCertificate elements of the current path to |*out_path|.
  void CopyPath(ParsedCertificateList *out_path) {
    out_path->clear();
    for (const auto &node : cur_path_) {
      out_path->push_back(node->reference_cert());
    }
  }

  // Returns true if the path is empty.
  bool Empty() const { return cur_path_.empty(); }

  // Returns the last CertIssuersIter in the path.
  CertIssuersIter *back() { return cur_path_.back().get(); }

  // Returns the length of the path.
  size_t Length() const { return cur_path_.size(); }

  std::string PathDebugString() {
    std::string s;
    for (const auto &node : cur_path_) {
      if (!s.empty()) {
        s += "\n";
      }
      s += " " + CertDebugString(node->cert());
    }
    return s;
  }

 private:
  using Key = std::tuple<std::string_view, std::string_view, std::string_view>;

  static Key GetKey(const ParsedCertificate *cert) {
    // TODO(mattm): ideally this would use a normalized version of
    // SubjectAltName, but it's not that important just for LoopChecker.
    //
    // Note that subject_alt_names_extension().value will be empty if the cert
    // had no SubjectAltName extension, so there is no need for a condition on
    // has_subject_alt_names().
    return Key(BytesAsStringView(cert->normalized_subject()),
               BytesAsStringView(cert->subject_alt_names_extension().value),
               BytesAsStringView(cert->tbs().spki_tlv));
  }

  std::vector<std::unique_ptr<CertIssuersIter>> cur_path_;

  // This refers to data owned by |cur_path_|.
  // TODO(mattm): use unordered_set. Requires making a hash function for Key.
  std::set<Key> present_certs_;
};

}  // namespace

const ParsedCertificate *CertPathBuilderResultPath::GetTrustedCert() const {
  if (certs.empty()) {
    return nullptr;
  }

  switch (last_cert_trust.type) {
    case CertificateTrustType::TRUSTED_ANCHOR:
    case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
    case CertificateTrustType::TRUSTED_LEAF:
      return certs.back().get();
    case CertificateTrustType::UNSPECIFIED:
    case CertificateTrustType::DISTRUSTED:
      return nullptr;
  }

  assert(0);  // NOTREACHED
  return nullptr;
}

// CertPathIter generates possible paths from |cert| to a trust anchor in
// |trust_store|, using intermediates from the |cert_issuer_source| objects if
// necessary.
class CertPathIter {
 public:
  CertPathIter(std::shared_ptr<const ParsedCertificate> cert,
               TrustStore *trust_store);

  CertPathIter(const CertPathIter &) = delete;
  CertPathIter &operator=(const CertPathIter &) = delete;

  // Adds a CertIssuerSource to provide intermediates for use in path building.
  // The |*cert_issuer_source| must remain valid for the lifetime of the
  // CertPathIter.
  void AddCertIssuerSource(CertIssuerSource *cert_issuer_source);

  // Gets the next candidate path, and fills it into |out_certs| and
  // |out_last_cert_trust|. Note that the returned path is unverified and must
  // still be run through a chain validator. If a candidate path could not be
  // built, a partial path will be returned and |out_errors| will have an error
  // added.
  // If the return value is true, GetNextPath may be called again to backtrack
  // and continue path building. Once all paths have been exhausted returns
  // false. If deadline or iteration limit is exceeded, sets |out_certs| to the
  // current path being explored and returns false.
  bool GetNextPath(ParsedCertificateList *out_certs,
                   CertificateTrust *out_last_cert_trust,
                   CertPathErrors *out_errors,
                   CertPathBuilderDelegate *delegate, uint32_t *iteration_count,
                   const uint32_t max_iteration_count,
                   const uint32_t max_path_building_depth);

 private:
  // Stores the next candidate issuer, until it is used during the
  // STATE_GET_NEXT_ISSUER_COMPLETE step.
  IssuerEntry next_issuer_;
  // The current path being explored, made up of CertIssuerIters. Each node
  // keeps track of the state of searching for issuers of that cert, so that
  // when backtracking it can resume the search where it left off.
  CertIssuerIterPath cur_path_;
  // The CertIssuerSources for retrieving candidate issuers.
  CertIssuerSources cert_issuer_sources_;
  // The TrustStore for checking if a path ends in a trust anchor.
  TrustStore *trust_store_;
};

CertPathIter::CertPathIter(std::shared_ptr<const ParsedCertificate> cert,
                           TrustStore *trust_store)
    : trust_store_(trust_store) {
  // Initialize |next_issuer_| to the target certificate.
  next_issuer_.cert = std::move(cert);
  next_issuer_.trust = trust_store_->GetTrust(next_issuer_.cert.get());
}

void CertPathIter::AddCertIssuerSource(CertIssuerSource *cert_issuer_source) {
  cert_issuer_sources_.push_back(cert_issuer_source);
}

bool CertPathIter::GetNextPath(ParsedCertificateList *out_certs,
                               CertificateTrust *out_last_cert_trust,
                               CertPathErrors *out_errors,
                               CertPathBuilderDelegate *delegate,
                               uint32_t *iteration_count,
                               const uint32_t max_iteration_count,
                               const uint32_t max_path_building_depth) {
  out_certs->clear();
  *out_last_cert_trust = CertificateTrust::ForUnspecified();

  while (true) {
    if (delegate->IsDeadlineExpired()) {
      if (cur_path_.Empty()) {
        // If the deadline is already expired before the first call to
        // GetNextPath, cur_path_ will be empty. Return the leaf cert in that
        // case.
        if (next_issuer_.cert) {
          out_certs->push_back(next_issuer_.cert);
        }
      } else {
        cur_path_.CopyPath(out_certs);
      }
      out_errors->GetOtherErrors()->AddError(cert_errors::kDeadlineExceeded);
      return false;
    }

    // We are not done yet, so if the current path is at the depth limit then
    // we must backtrack to find an acceptable solution.
    if (max_path_building_depth > 0 &&
        cur_path_.Length() >= max_path_building_depth) {
      cur_path_.CopyPath(out_certs);
      out_errors->GetOtherErrors()->AddError(cert_errors::kDepthLimitExceeded);
      if (delegate->IsDebugLogEnabled()) {
        delegate->DebugLog(
            "CertPathIter reached depth limit. Returning "
            "partial path and backtracking:\n" +
            PathDebugString(*out_certs));
      }
      cur_path_.Pop();
      return true;
    }

    if (!next_issuer_.cert) {
      if (cur_path_.Empty()) {
        if (delegate->IsDebugLogEnabled()) {
          delegate->DebugLog("CertPathIter exhausted all paths...");
        }
        return false;
      }

      (*iteration_count)++;
      if (max_iteration_count > 0 && *iteration_count > max_iteration_count) {
        cur_path_.CopyPath(out_certs);
        out_errors->GetOtherErrors()->AddError(
            cert_errors::kIterationLimitExceeded);
        return false;
      }

      cur_path_.back()->GetNextIssuer(&next_issuer_);
      if (!next_issuer_.cert) {
        if (!cur_path_.back()->had_non_skipped_issuers()) {
          // If the end of a path was reached without finding an anchor, return
          // the partial path before backtracking.
          cur_path_.CopyPath(out_certs);
          out_errors->GetErrorsForCert(out_certs->size() - 1)
              ->AddError(cert_errors::kNoIssuersFound);
          if (delegate->IsDebugLogEnabled()) {
            delegate->DebugLog(
                "CertPathIter returning partial path and backtracking:\n" +
                PathDebugString(*out_certs));
          }
          cur_path_.Pop();
          return true;
        } else {
          // No more issuers for current chain, go back up and see if there are
          // any more for the previous cert.
          if (delegate->IsDebugLogEnabled()) {
            delegate->DebugLog("CertPathIter backtracking...");
          }
          cur_path_.Pop();
          continue;
        }
      }
    }

    // Overrides for cert with trust appearing in the wrong place for the type
    // of trust (trusted leaf in non-leaf position, or trust anchor in leaf
    // position.)
    switch (next_issuer_.trust.type) {
      case CertificateTrustType::TRUSTED_ANCHOR:
        // If the leaf cert is trusted only as an anchor, treat it as having
        // unspecified trust. This may allow a successful path to be built to a
        // different root (or to the same cert if it's self-signed).
        if (cur_path_.Empty()) {
          if (delegate->IsDebugLogEnabled()) {
            delegate->DebugLog(
                "Leaf is a trust anchor, considering as UNSPECIFIED");
          }
          next_issuer_.trust = CertificateTrust::ForUnspecified();
        }
        break;
      case CertificateTrustType::TRUSTED_LEAF:
        // If a non-leaf cert is trusted only as a leaf, treat it as having
        // unspecified trust. This may allow a successful path to be built to a
        // trusted root.
        if (!cur_path_.Empty()) {
          if (delegate->IsDebugLogEnabled()) {
            delegate->DebugLog(
                "Issuer is a trust leaf, considering as UNSPECIFIED");
          }
          next_issuer_.trust = CertificateTrust::ForUnspecified();
        }
        break;
      case CertificateTrustType::DISTRUSTED:
      case CertificateTrustType::UNSPECIFIED:
      case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
        // No override necessary.
        break;
    }

    // Overrides for trusted leaf cert with require_leaf_selfsigned. If the leaf
    // isn't actually self-signed, treat it as unspecified.
    switch (next_issuer_.trust.type) {
      case CertificateTrustType::TRUSTED_LEAF:
      case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
        if (cur_path_.Empty() && next_issuer_.trust.require_leaf_selfsigned &&
            !VerifyCertificateIsSelfSigned(*next_issuer_.cert,
                                           delegate->GetVerifyCache(),
                                           /*errors=*/nullptr)) {
          if (delegate->IsDebugLogEnabled()) {
            delegate->DebugLog(
                "Leaf is trusted with require_leaf_selfsigned but is "
                "not self-signed, considering as UNSPECIFIED");
          }
          next_issuer_.trust = CertificateTrust::ForUnspecified();
        }
        break;
      case CertificateTrustType::TRUSTED_ANCHOR:
      case CertificateTrustType::DISTRUSTED:
      case CertificateTrustType::UNSPECIFIED:
        // No override necessary.
        break;
    }

    switch (next_issuer_.trust.type) {
      // If the trust for this issuer is "known" (either because it is
      // distrusted, or because it is trusted) then stop building and return the
      // path.
      case CertificateTrustType::DISTRUSTED:
      case CertificateTrustType::TRUSTED_ANCHOR:
      case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
      case CertificateTrustType::TRUSTED_LEAF: {
        // If the issuer has a known trust level, can stop building the path.
        cur_path_.CopyPath(out_certs);
        out_certs->push_back(std::move(next_issuer_.cert));
        if (delegate->IsDebugLogEnabled()) {
          delegate->DebugLog("CertPathIter returning path:\n" +
                             PathDebugString(*out_certs));
        }
        *out_last_cert_trust = next_issuer_.trust;
        next_issuer_ = IssuerEntry();
        return true;
      }
      case CertificateTrustType::UNSPECIFIED: {
        // Skip this cert if it is already in the chain.
        if (cur_path_.IsPresent(next_issuer_.cert.get())) {
          cur_path_.back()->increment_skipped_issuer_count();
          if (delegate->IsDebugLogEnabled()) {
            delegate->DebugLog("CertPathIter skipping dupe cert: " +
                               CertDebugString(next_issuer_.cert.get()));
          }
          next_issuer_ = IssuerEntry();
          continue;
        }

        cur_path_.Append(std::make_unique<CertIssuersIter>(
            std::move(next_issuer_.cert), &cert_issuer_sources_, trust_store_));
        next_issuer_ = IssuerEntry();
        if (delegate->IsDebugLogEnabled()) {
          delegate->DebugLog("CertPathIter cur_path_ =\n" +
                             cur_path_.PathDebugString());
        }
        // Continue descending the tree.
        continue;
      }
    }
  }
}

CertPathBuilderResultPath::CertPathBuilderResultPath() = default;
CertPathBuilderResultPath::~CertPathBuilderResultPath() = default;

bool CertPathBuilderResultPath::IsValid() const {
  return GetTrustedCert() && !errors.ContainsHighSeverityErrors();
}

VerifyError CertPathBuilderResultPath::GetVerifyError() const {
  // Diagnostic string is always "everything" about the path.
  std::string diagnostic = errors.ToDebugString(certs);
  if (!errors.ContainsHighSeverityErrors()) {
    // TODO(bbe3): Having to check this after seems awkward: crbug.com/boringssl/713
    if (GetTrustedCert()) {
      return VerifyError(VerifyError::StatusCode::PATH_VERIFIED, 0,
                         std::move(diagnostic));
    } else {
      return VerifyError(VerifyError::StatusCode::VERIFICATION_FAILURE, -1,
                         std::move(diagnostic));
    }
  }

  // Check for the presence of things that amount to Internal errors in the
  // verification code. We deliberately prioritize this to not hide it in
  // multiple error cases.
  if (errors.ContainsError(cert_errors::kInternalError) ||
      errors.ContainsError(cert_errors::kChainIsEmpty)) {
    return VerifyError(VerifyError::StatusCode::VERIFICATION_FAILURE, -1,
                       std::move(diagnostic));
  }

  // Similarly, for the deadline and limit cases, there will often be other
  // errors that we probably do not care about, since path building was
  // aborted. Surface these errors instead of having them hidden in the multiple
  // error case.
  //
  // Normally callers should check for these in the path builder result before
  // calling this on a single path, but this is here in case they do not and
  // these errors are actually present on this path.
  if (errors.ContainsError(cert_errors::kDeadlineExceeded)) {
    return VerifyError(VerifyError::StatusCode::PATH_DEADLINE_EXCEEDED, -1,
                       std::move(diagnostic));
  }
  if (errors.ContainsError(cert_errors::kIterationLimitExceeded)) {
    return VerifyError(VerifyError::StatusCode::PATH_ITERATION_COUNT_EXCEEDED,
                       -1, std::move(diagnostic));
  }
  if (errors.ContainsError(cert_errors::kDepthLimitExceeded)) {
    return VerifyError(VerifyError::StatusCode::PATH_DEPTH_LIMIT_REACHED, -1,
                       std::move(diagnostic));
  }

  // If the chain has multiple high severity errors, indicate that.
  ptrdiff_t depth = -1;
  std::optional<CertErrorId> single_error =
      errors.FindSingleHighSeverityError(depth);
  if (!single_error.has_value()) {
    return VerifyError(VerifyError::StatusCode::PATH_MULTIPLE_ERRORS, -1,
                       std::move(diagnostic));
  }

  // Otherwise it has a single error, map it appropriately at the
  // depth it first occurs.
  if (single_error.value() == cert_errors::kValidityFailedNotAfter) {
    return VerifyError(VerifyError::StatusCode::CERTIFICATE_EXPIRED, depth,
                       std::move(diagnostic));
  }
  if (single_error.value() == cert_errors::kValidityFailedNotBefore) {
    return VerifyError(VerifyError::StatusCode::CERTIFICATE_NOT_YET_VALID,
                       depth, std::move(diagnostic));
  }
  if (single_error.value() == cert_errors::kDistrustedByTrustStore ||
      single_error.value() == cert_errors::kCertIsNotTrustAnchor ||
      single_error.value() == cert_errors::kMaxPathLengthViolated ||
      single_error.value() == cert_errors::kSubjectDoesNotMatchIssuer ||
      single_error.value() == cert_errors::kNoIssuersFound) {
    return VerifyError(VerifyError::StatusCode::PATH_NOT_FOUND, depth,
                       std::move(diagnostic));
  }
  if (single_error.value() == cert_errors::kVerifySignedDataFailed) {
    return VerifyError(VerifyError::StatusCode::CERTIFICATE_INVALID_SIGNATURE,
                       depth, std::move(diagnostic));
  }
  if (single_error.value() == cert_errors::kUnacceptableSignatureAlgorithm) {
    return VerifyError(
        VerifyError::StatusCode::CERTIFICATE_UNSUPPORTED_SIGNATURE_ALGORITHM,
        depth, std::move(diagnostic));
  }
  if (single_error.value() == cert_errors::kUnacceptablePublicKey) {
    return VerifyError(VerifyError::StatusCode::CERTIFICATE_UNSUPPORTED_KEY,
                       depth, std::move(diagnostic));
  }
  if (single_error.value() == cert_errors::kEkuLacksServerAuth ||
      single_error.value() == cert_errors::kEkuLacksServerAuthButHasAnyEKU ||
      single_error.value() == cert_errors::kEkuLacksClientAuth ||
      single_error.value() == cert_errors::kEkuLacksClientAuthButHasAnyEKU ||
      single_error.value() == cert_errors::kEkuLacksClientAuthOrServerAuth) {
    return VerifyError(VerifyError::StatusCode::CERTIFICATE_NO_MATCHING_EKU,
                       depth, std::move(diagnostic));
  }
  if (single_error.value() == cert_errors::kCertificateRevoked) {
    return VerifyError(VerifyError::StatusCode::CERTIFICATE_REVOKED, depth,
                       std::move(diagnostic));
  }
  if (single_error.value() == cert_errors::kNoRevocationMechanism) {
    return VerifyError(
        VerifyError::StatusCode::CERTIFICATE_NO_REVOCATION_MECHANISM, depth,
        std::move(diagnostic));
  }
  if (single_error.value() == cert_errors::kUnableToCheckRevocation) {
    return VerifyError(
        VerifyError::StatusCode::CERTIFICATE_UNABLE_TO_CHECK_REVOCATION, depth,
        std::move(diagnostic));
  }
  // All other High severity errors map to CERTIFICATE_INVALID if associated
  // to a certificate, or VERIFICATION_FAILURE if not associated to a
  // certificate.
  return VerifyError((depth < 0) ? VerifyError::StatusCode::VERIFICATION_FAILURE
                                 : VerifyError::StatusCode::CERTIFICATE_INVALID,
                     depth, std::move(diagnostic));
}


CertPathBuilder::Result::Result() = default;
CertPathBuilder::Result::Result(Result &&) = default;
CertPathBuilder::Result::~Result() = default;
CertPathBuilder::Result &CertPathBuilder::Result::operator=(Result &&) =
    default;

bool CertPathBuilder::Result::HasValidPath() const {
  return GetBestValidPath() != nullptr;
}

bool CertPathBuilder::Result::AnyPathContainsError(CertErrorId error_id) const {
  for (const auto &path : paths) {
    if (path->errors.ContainsError(error_id)) {
      return true;
    }
  }

  return false;
}

const VerifyError CertPathBuilder::Result::GetBestPathVerifyError() const {
  if (HasValidPath()) {
    return GetBestValidPath()->GetVerifyError();
  }
  // We can only return one error. Returning the errors corresponding to the
  // limits if they they appear on any path will make this error prominent even
  // if there are other paths with different or multiple errors.
  if (exceeded_iteration_limit) {
    return VerifyError(
        VerifyError::StatusCode::PATH_ITERATION_COUNT_EXCEEDED, -1,
        "Iteration count exceeded, could not find a trusted path.");
  }
  if (exceeded_deadline) {
    return VerifyError(VerifyError::StatusCode::PATH_DEADLINE_EXCEEDED, -1,
                       "Deadline exceeded. Could not find a trusted path.");
  }
  if (AnyPathContainsError(cert_errors::kDepthLimitExceeded)) {
    return VerifyError(VerifyError::StatusCode::PATH_DEPTH_LIMIT_REACHED, -1,
                       "Depth limit reached. Could not find a trusted path.");
  }

  // If there are no paths to report an error on, this probably indicates
  // something is wrong with this path builder result.
  if (paths.empty()) {
    return VerifyError(VerifyError::StatusCode::VERIFICATION_FAILURE, -1,
                       "No paths in path builder result.");
  }

  // If there are paths, report the VerifyError from the best path.
  CertPathBuilderResultPath *path = paths[best_result_index].get();
  return path->GetVerifyError();
}

const CertPathBuilderResultPath *CertPathBuilder::Result::GetBestValidPath()
    const {
  const CertPathBuilderResultPath *result_path = GetBestPathPossiblyInvalid();

  if (result_path && result_path->IsValid()) {
    return result_path;
  }

  return nullptr;
}

const CertPathBuilderResultPath *
CertPathBuilder::Result::GetBestPathPossiblyInvalid() const {
  BSSL_CHECK((paths.empty() && best_result_index == 0) ||
             best_result_index < paths.size());

  if (best_result_index >= paths.size()) {
    return nullptr;
  }

  return paths[best_result_index].get();
}

CertPathBuilder::CertPathBuilder(
    std::shared_ptr<const ParsedCertificate> cert, TrustStore *trust_store,
    CertPathBuilderDelegate *delegate, const der::GeneralizedTime &time,
    KeyPurpose key_purpose, InitialExplicitPolicy initial_explicit_policy,
    const std::set<der::Input> &user_initial_policy_set,
    InitialPolicyMappingInhibit initial_policy_mapping_inhibit,
    InitialAnyPolicyInhibit initial_any_policy_inhibit)
    : cert_path_iter_(
          std::make_unique<CertPathIter>(std::move(cert), trust_store)),
      delegate_(delegate),
      time_(time),
      key_purpose_(key_purpose),
      initial_explicit_policy_(initial_explicit_policy),
      user_initial_policy_set_(user_initial_policy_set),
      initial_policy_mapping_inhibit_(initial_policy_mapping_inhibit),
      initial_any_policy_inhibit_(initial_any_policy_inhibit) {
  BSSL_CHECK(delegate);
  // The TrustStore also implements the CertIssuerSource interface.
  AddCertIssuerSource(trust_store);
}

CertPathBuilder::~CertPathBuilder() = default;

void CertPathBuilder::AddCertIssuerSource(
    CertIssuerSource *cert_issuer_source) {
  cert_path_iter_->AddCertIssuerSource(cert_issuer_source);
}

void CertPathBuilder::SetIterationLimit(uint32_t limit) {
  max_iteration_count_ = limit;
}

void CertPathBuilder::SetDepthLimit(uint32_t limit) {
  max_path_building_depth_ = limit;
}

void CertPathBuilder::SetValidPathLimit(size_t limit) {
  valid_path_limit_ = limit;
}

void CertPathBuilder::SetExploreAllPaths(bool explore_all_paths) {
  valid_path_limit_ = explore_all_paths ? 0 : 1;
}

CertPathBuilder::Result CertPathBuilder::Run() {
  uint32_t iteration_count = 0;

  while (true) {
    std::unique_ptr<CertPathBuilderResultPath> result_path =
        std::make_unique<CertPathBuilderResultPath>();

    if (!cert_path_iter_->GetNextPath(
            &result_path->certs, &result_path->last_cert_trust,
            &result_path->errors, delegate_, &iteration_count,
            max_iteration_count_, max_path_building_depth_)) {
      // There are no more paths to check or limits were exceeded.
      if (result_path->errors.ContainsError(
              cert_errors::kIterationLimitExceeded)) {
        out_result_.exceeded_iteration_limit = true;
      }
      if (result_path->errors.ContainsError(cert_errors::kDeadlineExceeded)) {
        out_result_.exceeded_deadline = true;
      }
      if (!result_path->certs.empty()) {
        // It shouldn't be possible to get here without adding one of the
        // errors above, but just in case, add an error if there isn't one
        // already.
        if (!result_path->errors.ContainsHighSeverityErrors()) {
          result_path->errors.GetOtherErrors()->AddError(
              cert_errors::kInternalError);
        }

        // Allow the delegate to do any processing or logging of the partial
        // path. (This is for symmetry for the other CheckPathAfterVerification
        // which also gets called on partial paths.)
        delegate_->CheckPathAfterVerification(*this, result_path.get());

        AddResultPath(std::move(result_path));
      }
      out_result_.iteration_count = iteration_count;
      return std::move(out_result_);
    }

    if (result_path->last_cert_trust.HasUnspecifiedTrust()) {
      // Partial path, don't attempt to verify. Just double check that it is
      // marked with an error, and move on.
      if (!result_path->errors.ContainsHighSeverityErrors()) {
        result_path->errors.GetOtherErrors()->AddError(
            cert_errors::kInternalError);
      }
    } else {
      // Verify the entire certificate chain.
      VerifyCertificateChain(
          result_path->certs, result_path->last_cert_trust, delegate_, time_,
          key_purpose_, initial_explicit_policy_, user_initial_policy_set_,
          initial_policy_mapping_inhibit_, initial_any_policy_inhibit_,
          &result_path->user_constrained_policy_set, &result_path->errors);
    }

    // Give the delegate a chance to add errors to the path.
    delegate_->CheckPathAfterVerification(*this, result_path.get());

    bool path_is_good = result_path->IsValid();

    AddResultPath(std::move(result_path));

    if (path_is_good) {
      valid_path_count_++;
      if (valid_path_limit_ > 0 && valid_path_count_ == valid_path_limit_) {
        out_result_.iteration_count = iteration_count;
        // Found enough paths, return immediately.
        return std::move(out_result_);
      }
    }
    // Path did not verify. Try more paths.
  }
}

void CertPathBuilder::AddResultPath(
    std::unique_ptr<CertPathBuilderResultPath> result_path) {
  // TODO(mattm): If there are no valid paths, set best_result_index based on
  // number or severity of errors. If there are multiple valid paths, could set
  // best_result_index based on prioritization (since due to AIA and such, the
  // actual order results were discovered may not match the ideal).
  if (!out_result_.HasValidPath()) {
    const CertPathBuilderResultPath *old_best_path =
        out_result_.GetBestPathPossiblyInvalid();
    // If |result_path| is a valid path or if the previous best result did not
    // end in a trust anchor but the |result_path| does, then update the best
    // result to the new result.
    if (result_path->IsValid() ||
        (!result_path->last_cert_trust.HasUnspecifiedTrust() && old_best_path &&
         old_best_path->last_cert_trust.HasUnspecifiedTrust())) {
      out_result_.best_result_index = out_result_.paths.size();
    }
  }
  if (result_path->certs.size() > out_result_.max_depth_seen) {
    out_result_.max_depth_seen = result_path->certs.size();
  }
  out_result_.paths.push_back(std::move(result_path));
}

BSSL_NAMESPACE_END
