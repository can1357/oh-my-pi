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

#include "verify_certificate_chain.h"

#include <algorithm>
#include <cassert>

#include <openssl/base.h>
#include "cert_error_params.h"
#include "cert_errors.h"
#include "common_cert_errors.h"
#include "extended_key_usage.h"
#include "input.h"
#include "name_constraints.h"
#include "parse_certificate.h"
#include "signature_algorithm.h"
#include "trust_store.h"
#include "verify_signed_data.h"

BSSL_NAMESPACE_BEGIN

namespace {

bool IsHandledCriticalExtension(const ParsedExtension &extension) {
  if (extension.oid == der::Input(kBasicConstraintsOid)) {
    return true;
  }
  // Key Usage is NOT processed for end-entity certificates (this is the
  // responsibility of callers), however it is considered "handled" here in
  // order to allow being marked as critical.
  if (extension.oid == der::Input(kKeyUsageOid)) {
    return true;
  }
  if (extension.oid == der::Input(kExtKeyUsageOid)) {
    return true;
  }
  if (extension.oid == der::Input(kNameConstraintsOid)) {
    return true;
  }
  if (extension.oid == der::Input(kSubjectAltNameOid)) {
    return true;
  }
  if (extension.oid == der::Input(kCertificatePoliciesOid)) {
    // Policy qualifiers are skipped during processing, so if the
    // extension is marked critical need to ensure there weren't any
    // qualifiers other than User Notice / CPS.
    //
    // This follows from RFC 5280 section 4.2.1.4:
    //
    //   If this extension is critical, the path validation software MUST
    //   be able to interpret this extension (including the optional
    //   qualifier), or MUST reject the certificate.
    std::vector<der::Input> unused_policies;
    CertErrors unused_errors;
    return ParseCertificatePoliciesExtensionOids(
        extension.value, true /*fail_parsing_unknown_qualifier_oids*/,
        &unused_policies, &unused_errors);

    // TODO(eroman): Give a better error message.
  }
  if (extension.oid == der::Input(kPolicyMappingsOid)) {
    return true;
  }
  if (extension.oid == der::Input(kPolicyConstraintsOid)) {
    return true;
  }
  if (extension.oid == der::Input(kInhibitAnyPolicyOid)) {
    return true;
  }

  return false;
}

// Adds errors to |errors| if the certificate contains unconsumed _critical_
// extensions.
void VerifyNoUnconsumedCriticalExtensions(const ParsedCertificate &cert,
                                          CertErrors *errors,
                                          bool allow_precertificate,
                                          KeyPurpose key_purpose) {
  for (const auto &it : cert.extensions()) {
    const ParsedExtension &extension = it.second;
    if (extension.critical) {
      if (key_purpose == KeyPurpose::RCS_MLS_CLIENT_AUTH) {
        if (extension.oid == der::Input(kRcsMlsParticipantInformation) ||
            extension.oid == der::Input(kRcsMlsAcsParticipantInformation)) {
          continue;
        }
      }
      if (allow_precertificate && extension.oid == der::Input(kCtPoisonOid)) {
        continue;
      }
      if (extension.oid == der::Input(kMSApplicationPoliciesOid) &&
          cert.has_extended_key_usage()) {
        // Per https://crbug.com/1439638 and
        // https://learn.microsoft.com/en-us/windows/win32/seccertenroll/supported-extensions#msapplicationpolicies
        // The MSApplicationPolicies extension may be ignored if the
        // extendedKeyUsage extension is also present.
        continue;
      }
      if (!IsHandledCriticalExtension(extension)) {
        errors->AddError(cert_errors::kUnconsumedCriticalExtension,
                         CreateCertErrorParams2Der("oid", extension.oid,
                                                   "value", extension.value));
      }
    }
  }
}

// Returns true if |cert| was self-issued. The definition of self-issuance
// comes from RFC 5280 section 6.1:
//
//    A certificate is self-issued if the same DN appears in the subject
//    and issuer fields (the two DNs are the same if they match according
//    to the rules specified in Section 7.1).  In general, the issuer and
//    subject of the certificates that make up a path are different for
//    each certificate.  However, a CA may issue a certificate to itself to
//    support key rollover or changes in certificate policies.  These
//    self-issued certificates are not counted when evaluating path length
//    or name constraints.
[[nodiscard]] bool IsSelfIssued(const ParsedCertificate &cert) {
  return cert.normalized_subject() == cert.normalized_issuer();
}

// Adds errors to |errors| if |cert| is not valid at time |time|.
//
// The certificate's validity requirements are described by RFC 5280 section
// 4.1.2.5:
//
//    The validity period for a certificate is the period of time from
//    notBefore through notAfter, inclusive.
void VerifyTimeValidity(const ParsedCertificate &cert,
                        const der::GeneralizedTime &time, CertErrors *errors) {
  if (time < cert.tbs().validity_not_before) {
    errors->AddError(cert_errors::kValidityFailedNotBefore);
  }

  if (cert.tbs().validity_not_after < time) {
    errors->AddError(cert_errors::kValidityFailedNotAfter);
  }
}

// Adds errors to |errors| if |cert| has internally inconsistent signature
// algorithms.
//
// X.509 certificates contain two different signature algorithms:
//  (1) The signatureAlgorithm field of Certificate
//  (2) The signature field of TBSCertificate
//
// According to RFC 5280 section 4.1.1.2 and 4.1.2.3 these two fields must be
// equal:
//
//     This field MUST contain the same algorithm identifier as the
//     signature field in the sequence tbsCertificate (Section 4.1.2.3).
//
// The spec is not explicit about what "the same algorithm identifier" means.
// Our interpretation is that the two DER-encoded fields must be byte-for-byte
// identical.
//
// In practice however there are certificates which use different encodings for
// specifying RSA with SHA1 (different OIDs). This is special-cased for
// compatibility sake.
bool VerifySignatureAlgorithmsMatch(const ParsedCertificate &cert,
                                    CertErrors *errors) {
  der::Input alg1_tlv = cert.signature_algorithm_tlv();
  der::Input alg2_tlv = cert.tbs().signature_algorithm_tlv;

  // Ensure that the two DER-encoded signature algorithms are byte-for-byte
  // equal.
  if (alg1_tlv == alg2_tlv) {
    return true;
  }

  // But make a compatibility concession if alternate encodings are used
  // TODO(eroman): Turn this warning into an error.
  // TODO(eroman): Add a unit-test that exercises this case.
  std::optional<SignatureAlgorithm> alg1 = ParseSignatureAlgorithm(alg1_tlv);
  if (!alg1) {
    errors->AddError(cert_errors::kUnacceptableSignatureAlgorithm);
    return false;
  }
  std::optional<SignatureAlgorithm> alg2 = ParseSignatureAlgorithm(alg2_tlv);
  if (!alg2) {
    errors->AddError(cert_errors::kUnacceptableSignatureAlgorithm);
    return false;
  }

  if (*alg1 == *alg2) {
    errors->AddWarning(
        cert_errors::kSignatureAlgorithmsDifferentEncoding,
        CreateCertErrorParams2Der("Certificate.algorithm", alg1_tlv,
                                  "TBSCertificate.signature", alg2_tlv));
    return true;
  }

  errors->AddError(
      cert_errors::kSignatureAlgorithmMismatch,
      CreateCertErrorParams2Der("Certificate.algorithm", alg1_tlv,
                                "TBSCertificate.signature", alg2_tlv));
  return false;
}

// Verify that |cert| can be used for |required_key_purpose|.
void VerifyExtendedKeyUsage(const ParsedCertificate &cert,
                            KeyPurpose required_key_purpose, CertErrors *errors,
                            bool is_target_cert, bool is_target_cert_issuer) {
  // We treat a required KeyPurpose of ANY_EKU to mean "Do not check EKU"
  if (required_key_purpose == KeyPurpose::ANY_EKU) {
    return;
  }
  bool has_any_eku = false;
  bool has_server_auth_eku = false;
  bool has_client_auth_eku = false;
  bool has_code_signing_eku = false;
  bool has_time_stamping_eku = false;
  bool has_ocsp_signing_eku = false;
  bool has_rcs_mls_client_eku = false;
  bool has_document_signing_eku = false;
  bool has_email_protection_eku = false;
  size_t eku_oid_count = 0;
  if (cert.has_extended_key_usage()) {
    for (const auto &key_purpose_oid : cert.extended_key_usage()) {
      eku_oid_count++;
      if (key_purpose_oid == der::Input(kAnyEKU)) {
        has_any_eku = true;
      }
      if (key_purpose_oid == der::Input(kServerAuth)) {
        has_server_auth_eku = true;
      }
      if (key_purpose_oid == der::Input(kClientAuth)) {
        has_client_auth_eku = true;
      }
      if (key_purpose_oid == der::Input(kCodeSigning)) {
        has_code_signing_eku = true;
      }
      if (key_purpose_oid == der::Input(kTimeStamping)) {
        has_time_stamping_eku = true;
      }
      if (key_purpose_oid == der::Input(kOCSPSigning)) {
        has_ocsp_signing_eku = true;
      }
      if (key_purpose_oid == der::Input(kRcsMlsClient)) {
        has_rcs_mls_client_eku = true;
      }
      if (key_purpose_oid == der::Input(kEmailProtection)) {
        has_email_protection_eku = true;
      }
      if (key_purpose_oid == der::Input(kDocumentSigning)) {
        has_document_signing_eku = true;
      }
    }
  }

  if (required_key_purpose == KeyPurpose::RCS_MLS_CLIENT_AUTH) {
    // Enforce the key usage restriction for a leaf from section A.3.8.3 here
    // as well.
    if (is_target_cert &&
        (!cert.has_key_usage() ||
         // This works to enforce that digital signature is the only bit because
         // digital signature is bit 0.
         !cert.key_usage().AssertsBit(KEY_USAGE_BIT_DIGITAL_SIGNATURE) ||
         cert.key_usage().bytes().size() != 1 ||
         cert.key_usage().unused_bits() != 7)) {
      errors->AddError(cert_errors::kKeyUsageIncorrectForRcsMlsClient);
    }
    // Rules for MLS client auth. For the leaf and all intermediates, EKU must
    // be present and have exactly one EKU which is rcsMlsClient.
    if (!cert.has_extended_key_usage()) {
      errors->AddError(cert_errors::kEkuNotPresent);
    } else if (eku_oid_count != 1 || !has_rcs_mls_client_eku) {
      errors->AddError(cert_errors::kEkuIncorrectForRcsMlsClient);
    }
    return;
  }

  if (required_key_purpose == KeyPurpose::C2PA_TIMESTAMPING) {
    // https://c2pa.org/specifications/specifications/2.1/specs/C2PA_Specification.html#_certificate_profiles
    // For time stamp signing, C2PA requires that the leaf:
    // 1) must have EKU
    // 2) must not have EKU ANY, OCSP signing, document signing, or email protection
    // 3) must have time stamping
    // 4) should tolerate other EKU's being present.
    if (is_target_cert) {
      if (!cert.has_extended_key_usage()) {
        errors->AddError(cert_errors::kEkuNotPresent);
      }
      if (has_any_eku || has_ocsp_signing_eku || has_document_signing_eku ||
          has_email_protection_eku || !has_time_stamping_eku) {
        errors->AddError(cert_errors::kEkuIncorrectForC2PATimeStamping);
      }
    }
    return;
  }

  if (required_key_purpose == KeyPurpose::C2PA_MANIFEST) {
    // https://c2pa.org/specifications/specifications/2.1/specs/C2PA_Specification.html#_certificate_profiles
    // For manifest signing, C2PA requires that the leaf:
    // 1) must have EKU
    // 2) must not have EKU ANY, time stamping, or OCSP signing
    // 3) should have document signing and/or email protection
    // 4) should tolerate other EKU's being present.
    if (is_target_cert) {
      if (!cert.has_extended_key_usage()) {
        errors->AddError(cert_errors::kEkuNotPresent);
      }
      if (!cert.has_key_usage() ||
          !cert.key_usage().AssertsBit(KEY_USAGE_BIT_DIGITAL_SIGNATURE) ||
          has_any_eku || has_ocsp_signing_eku || has_time_stamping_eku ||
          (!has_email_protection_eku && !has_document_signing_eku)) {
        errors->AddError(cert_errors::kEkuIncorrectForC2PAManifest);
      }
    }
    return;
  }

  // Rules TLS client and server authentication variants.

  // Apply strict only to leaf certificates in these cases.
  if (required_key_purpose == KeyPurpose::CLIENT_AUTH_STRICT_LEAF) {
    if (!is_target_cert) {
      required_key_purpose = KeyPurpose::CLIENT_AUTH;
    } else {
      required_key_purpose = KeyPurpose::CLIENT_AUTH_STRICT;
    }
  }

  if (required_key_purpose == KeyPurpose::SERVER_AUTH_STRICT_LEAF) {
    if (!is_target_cert) {
      required_key_purpose = KeyPurpose::SERVER_AUTH;
    } else {
      required_key_purpose = KeyPurpose::SERVER_AUTH_STRICT;
    }
  }

  auto add_error_if_strict = [&](CertErrorId id) {
    if (required_key_purpose == KeyPurpose::SERVER_AUTH_STRICT ||
        required_key_purpose == KeyPurpose::CLIENT_AUTH_STRICT) {
      errors->AddError(id);
    } else {
      errors->AddWarning(id);
    }
  };
  if (is_target_cert) {
    // Loosely based upon CABF BR version 1.8.4, 7.1.2.3(f).  We are more
    // permissive in that we still allow EKU any to be present in a leaf
    // certificate, but we ignore it for purposes of server or client auth.  We
    // are less permissive in that we prohibit Code Signing, OCSP Signing, and
    // Time Stamping which are currently only a SHOULD NOT. The BR does
    // explicitly allow Email authentication to be present, as this still exists
    // in the wild (2022), so we do not prohibit Email authentication here (and
    // by extension must allow it to be present in the signer, below).
    if (!cert.has_extended_key_usage()) {
      // This is added as a warning, an error will be added in STRICT modes
      // if we then lack client or server auth due to this not being present.
      errors->AddWarning(cert_errors::kEkuNotPresent);
    } else {
      if (has_code_signing_eku) {
        add_error_if_strict(cert_errors::kEkuHasProhibitedCodeSigning);
      }
      if (has_ocsp_signing_eku) {
        add_error_if_strict(cert_errors::kEkuHasProhibitedOCSPSigning);
      }
      if (has_time_stamping_eku) {
        add_error_if_strict(cert_errors::kEkuHasProhibitedTimeStamping);
      }
    }
  } else if (is_target_cert_issuer) {
    // Handle the decision to overload EKU as a constraint on issuers.
    //
    // CABF BR version 1.8.4, 7.1.2.2(g) pertains to the case of "Certs used to
    // issue TLS certificates", While the BR refers to the entire chain of
    // intermediates, there are a number of exceptions regarding CA ownership
    // and cross signing which are impossible for us to know or enforce here.
    // Therefore, we can only enforce at the level of the intermediate that
    // issued our target certificate. This means we we differ in the following
    // ways:
    // - We only enforce at the issuer of the TLS certificate.
    // - We allow email protection to exist in the issuer, since without
    //   this it can not be allowed in the client (other than via EKU any))
    // - As in the leaf certificate case, we allow EKU any to be present, but
    //   we ignore it for the purposes of server or client auth.
    //
    // At this time (until at least 2023) some intermediates are lacking EKU in
    // the world at large from common CA's, so we allow the noEKU case to permit
    // everything.
    // TODO(bbe): enforce requiring EKU in the issuer when we can manage it.
    if (cert.has_extended_key_usage()) {
      if (has_code_signing_eku) {
        add_error_if_strict(cert_errors::kEkuHasProhibitedCodeSigning);
      }
      if (has_time_stamping_eku) {
        add_error_if_strict(cert_errors::kEkuHasProhibitedTimeStamping);
      }
    }
  }
  // Otherwise, we are a parent of an issuer of a TLS certificate.  The CABF
  // BR version 1.8.4, 7.1.2.2(g) goes as far as permitting EKU any in certain
  // cases of Cross Signing and CA Ownership, having permitted cases where EKU
  // is permitted to not be present at all. These cases are not practical to
  // differentiate here and therefore we don't attempt to enforce any further
  // EKU "constraints" on such certificates. Unlike the above cases we also
  // allow the use of EKU any for client or server auth constraint purposes.

  switch (required_key_purpose) {
    case KeyPurpose::ANY_EKU:
    case KeyPurpose::CLIENT_AUTH_STRICT_LEAF:
    case KeyPurpose::SERVER_AUTH_STRICT_LEAF:
    case KeyPurpose::RCS_MLS_CLIENT_AUTH:
    case KeyPurpose::C2PA_TIMESTAMPING:
    case KeyPurpose::C2PA_MANIFEST:
      assert(0);  // NOTREACHED
      return;
    case KeyPurpose::SERVER_AUTH:
    case KeyPurpose::SERVER_AUTH_STRICT: {
      if (has_any_eku && !has_server_auth_eku) {
        if (is_target_cert || is_target_cert_issuer) {
          errors->AddWarning(cert_errors::kEkuLacksServerAuthButHasAnyEKU);
        } else {
          // Accept anyEKU for server auth below target issuer.
          has_server_auth_eku = true;
        }
      }
      if (is_target_cert_issuer && !cert.has_extended_key_usage()) {
        // Accept noEKU for server auth in target issuer.
        // TODO(bbe): remove this once BR requirements catch up with CA's.
        has_server_auth_eku = true;
      }
      if (required_key_purpose == KeyPurpose::SERVER_AUTH) {
        // Legacy compatible.
        if (cert.has_extended_key_usage() && !has_server_auth_eku &&
            !has_any_eku) {
          errors->AddError(cert_errors::kEkuLacksServerAuth);
        }
      } else {
        if (!has_server_auth_eku) {
          errors->AddError(cert_errors::kEkuLacksServerAuth);
        }
      }
      break;
    }
    case KeyPurpose::CLIENT_AUTH:
    case KeyPurpose::CLIENT_AUTH_STRICT: {
      if (has_any_eku && !has_client_auth_eku) {
        if (is_target_cert || is_target_cert_issuer) {
          errors->AddWarning(cert_errors::kEkuLacksClientAuthButHasAnyEKU);
        } else {
          // accept anyEKU for client auth.
          has_client_auth_eku = true;
        }
      }
      if (required_key_purpose == KeyPurpose::CLIENT_AUTH) {
        // Legacy-compatible.
        if (cert.has_extended_key_usage() && !has_client_auth_eku &&
            !has_any_eku) {
          errors->AddError(cert_errors::kEkuLacksClientAuth);
        }
      } else {
        if (!has_client_auth_eku) {
          errors->AddError(cert_errors::kEkuLacksClientAuth);
        }
      }
      break;
    }
  }
}

// Representation of RFC 5280's "valid_policy_tree", used to keep track of the
// valid policies and policy re-mappings. This structure is defined in
// section 6.1.2.
//
// ValidPolicyGraph differs from RFC 5280's description in that:
//
//  (1) It does not track "qualifier_set". This is not needed as it is not
//      output by this implementation.
//
//  (2) It builds a directed acyclic graph, rather than a tree. When a given
//      policy matches multiple parents, RFC 5280 makes a separate node for
//      each parent. This representation condenses them into one node with
//      multiple parents.
//
//  (3) It does not track "expected_policy_set" or anyPolicy nodes directly.
//      Rather it maintains, only for the most recent level, whether there is an
//      anyPolicy node and an inverted map of all "expected_policy_set" values.
//
//  (4) Some pruning steps are deferred to when policies are evaluated, as a
//      reachability pass.
class ValidPolicyGraph {
 public:
  ValidPolicyGraph() = default;

  ValidPolicyGraph(const ValidPolicyGraph &) = delete;
  ValidPolicyGraph &operator=(const ValidPolicyGraph &) = delete;

  // A Node is an entry in the policy graph. It contains information about some
  // policy asserted by a certificate in the chain. The policy OID itself is
  // omitted because it is the key in the Level map.
  struct Node {
    // The list of "valid_policy" values for all nodes which are a parent of
    // this node, other than anyPolicy. If empty, this node has a single parent,
    // anyPolicy.
    //
    // Nodes whose parent is anyPolicy are root policies, and may be returned
    // in the authorities-constrained-policy-set. Nodes with a concrete policy
    // as a parent are derived from that policy in the issuer certificate,
    // possibly with a policy mapping applied.
    //
    // Note it is not possible for a policy to have both anyPolicy and a
    // concrete policy as a parent. Section 6.1.3, step d.1.ii only runs if
    // there was no match in step d.1.i.
    std::vector<der::Input> parent_policies;

    // Whether this node matches a policy mapping in the certificate. If true,
    // its "expected_policy_set" comes from the policy mappings extension. If
    // false, its "expected_policy_set" is itself.
    bool mapped = false;

    // Whether this node is reachable from some valid policy in the end-entity
    // certificate. Computed during GetValidRootPolicySet().
    bool reachable = false;
  };

  // The policy graph is organized into "levels", each corresponding to a
  // certificate in the chain. We maintain a map from "valid_policy" to the
  // corresponding Node. This is the set of policies asserted by this
  // certificate. The special anyPolicy OID is handled separately below.
  using Level = std::map<der::Input, Node>;

  // Additional per-level information that only needs to be maintained for the
  // bottom-most level.
  struct LevelDetails {
    // Maintains the "expected_policy_set" values for nodes in a level of the
    // graph, but the map is inverted from RFC 5280's formulation. For a given
    // policy OID P, other than anyPolicy, this map gives the set of nodes where
    // P appears in the node's "expected_policy_set". anyPolicy is handled
    // separately below.
    std::map<der::Input, std::vector<der::Input>> expected_policy_map;

    // Whether there is a node at this level whose "valid_policy" is anyPolicy.
    //
    // Note anyPolicy's "expected_policy_set" always {anyPolicy}, and anyPolicy
    // will never appear in the "expected_policy_set" of any other policy. That
    // means this field also captures how anyPolicy appears in
    // "expected_policy_set".
    bool has_any_policy = false;
  };

  // Initializes the ValidPolicyGraph.
  void Init() {
    SetNull();
    StartLevel();
    AddAnyPolicyNode();
  }

  // In RFC 5280 valid_policy_tree may be set to null. That is represented here
  // by emptiness.
  bool IsNull() const {
    return !current_level_.has_any_policy &&
           (levels_.empty() || levels_.back().empty());
  }
  void SetNull() {
    levels_.clear();
    current_level_ = LevelDetails{};
  }

  // Completes the previous level, returning a corresponding LevelDetails
  // structure, and starts a new level.
  LevelDetails StartLevel() {
    // Finish building expected_policy_map for the previous level.
    if (!levels_.empty()) {
      for (const auto &[policy, node] : levels_.back()) {
        if (!node.mapped) {
          current_level_.expected_policy_map[policy].push_back(policy);
        }
      }
    }

    LevelDetails prev_level = std::move(current_level_);
    levels_.emplace_back();
    current_level_ = LevelDetails{};
    return prev_level;
  }

  // Gets the set of policies (in terms of root authority's policy domain) that
  // are valid at the bottom level of the policy graph, intersected with
  // |user_initial_policy_set|. This is what X.509 calls
  // "user-constrained-policy-set".
  //
  // This method may only be called once, after the policy graph is constructed.
  std::set<der::Input> GetUserConstrainedPolicySet(
      const std::set<der::Input> &user_initial_policy_set) {
    if (levels_.empty()) {
      return {};
    }

    bool user_has_any_policy =
        user_initial_policy_set.count(der::Input(kAnyPolicyOid)) != 0;
    if (current_level_.has_any_policy) {
      if (user_has_any_policy) {
        return {der::Input(kAnyPolicyOid)};
      }
      return user_initial_policy_set;
    }

    // The root's policy domain is determined by nodes with anyPolicy as a
    // parent. However, we must limit to those which are reachable from the
    // end-entity certificate because we defer some pruning steps.
    for (auto &[policy, node] : levels_.back()) {
      // GCC before 8.1 tracks individual unused bindings and does not support
      // marking them [[maybe_unused]].
      (void)policy;
      node.reachable = true;
    }
    std::set<der::Input> policy_set;
    for (size_t i = levels_.size() - 1; i < levels_.size(); i--) {
      for (auto &[policy, node] : levels_[i]) {
        if (!node.reachable) {
          continue;
        }
        if (node.parent_policies.empty()) {
          // |node|'s parent is anyPolicy, so this is in the root policy domain.
          // Add it to the set if it is also in user's list.
          if (user_has_any_policy ||
              user_initial_policy_set.count(policy) > 0) {
            policy_set.insert(policy);
          }
        } else if (i > 0) {
          // Otherwise, continue searching the previous level.
          for (der::Input parent : node.parent_policies) {
            auto iter = levels_[i - 1].find(parent);
            if (iter != levels_[i - 1].end()) {
              iter->second.reachable = true;
            }
          }
        }
      }
    }
    return policy_set;
  }

  // Adds a node with policy anyPolicy to the current level.
  void AddAnyPolicyNode() {
    assert(!levels_.empty());
    current_level_.has_any_policy = true;
  }

  // Adds a node to the current level which is a child of |parent_policies| with
  // the specified policy.
  void AddNode(der::Input policy, std::vector<der::Input> parent_policies) {
    assert(policy != der::Input(kAnyPolicyOid));
    AddNodeReturningIterator(policy, std::move(parent_policies));
  }

  // Adds a node to the current level which is a child of anyPolicy with the
  // specified policy.
  void AddNodeWithParentAnyPolicy(der::Input policy) {
    // An empty parent set represents a node parented by anyPolicy.
    AddNode(policy, {});
  }

  // Maps |issuer_policy| to |subject_policy|, as in RFC 5280, section 6.1.4,
  // step b.1.
  void AddPolicyMapping(der::Input issuer_policy, der::Input subject_policy) {
    assert(issuer_policy != der::Input(kAnyPolicyOid));
    assert(subject_policy != der::Input(kAnyPolicyOid));
    if (levels_.empty()) {
      return;
    }

    // The mapping only applies if |issuer_policy| exists in the current level.
    auto issuer_policy_iter = levels_.back().find(issuer_policy);
    if (issuer_policy_iter == levels_.back().end()) {
      // If there is no match, it can instead match anyPolicy.
      if (!current_level_.has_any_policy) {
        return;
      }

      // From RFC 5280, section 6.1.4, step b.1:
      //
      //    If no node of depth i in the valid_policy_tree has a
      //    valid_policy of ID-P but there is a node of depth i with a
      //    valid_policy of anyPolicy, then generate a child node of
      //    the node of depth i-1 that has a valid_policy of anyPolicy
      //    as follows: [...]
      //
      // The anyPolicy node of depth i-1 is referring to the parent of the
      // anyPolicy node of depth i. The parent of anyPolicy is always anyPolicy.
      issuer_policy_iter = AddNodeReturningIterator(issuer_policy, {});
    }

    // Unmapped nodes have a singleton "expected_policy_set" containing their
    // valid_policy. Track whether nodes have been mapped so this can be filled
    // in at StartLevel().
    issuer_policy_iter->second.mapped = true;

    // Add |subject_policy| to |issuer_policy|'s "expected_policy_set".
    current_level_.expected_policy_map[subject_policy].push_back(issuer_policy);
  }

  // Removes the node with the specified policy from the current level.
  void DeleteNode(der::Input policy) {
    if (!levels_.empty()) {
      levels_.back().erase(policy);
    }
  }

 private:
  Level::iterator AddNodeReturningIterator(
      der::Input policy, std::vector<der::Input> parent_policies) {
    assert(policy != der::Input(kAnyPolicyOid));
    auto [iter, inserted] = levels_.back().insert(
        std::pair{policy, Node{std::move(parent_policies)}});
    // GCC before 8.1 tracks individual unused bindings and does not support
    // marking them [[maybe_unused]].
    (void)inserted;
    assert(inserted);
    return iter;
  }

  // The list of levels, starting from the root.
  std::vector<Level> levels_;
  // Additional information about the current level.
  LevelDetails current_level_;
};

// Class that encapsulates the state variables used by certificate path
// validation.
class PathVerifier {
 public:
  // Same parameters and meaning as VerifyCertificateChain().
  void Run(const ParsedCertificateList &certs,
           const CertificateTrust &last_cert_trust,
           VerifyCertificateChainDelegate *delegate,
           const der::GeneralizedTime &time, KeyPurpose required_key_purpose,
           InitialExplicitPolicy initial_explicit_policy,
           const std::set<der::Input> &user_initial_policy_set,
           InitialPolicyMappingInhibit initial_policy_mapping_inhibit,
           InitialAnyPolicyInhibit initial_any_policy_inhibit,
           std::set<der::Input> *user_constrained_policy_set,
           CertPathErrors *errors);

 private:
  // Verifies and updates the valid policies. This corresponds with RFC 5280
  // section 6.1.3 steps d-f.
  void VerifyPolicies(const ParsedCertificate &cert, bool is_target_cert,
                      CertErrors *errors);

  // Applies the policy mappings. This corresponds with RFC 5280 section 6.1.4
  // steps a-b.
  void VerifyPolicyMappings(const ParsedCertificate &cert, CertErrors *errors);

  // Applies policyConstraints and inhibitAnyPolicy. This corresponds with RFC
  // 5280 section 6.1.4 steps i-j.
  void ApplyPolicyConstraints(const ParsedCertificate &cert);

  // This function corresponds to RFC 5280 section 6.1.3's "Basic Certificate
  // Processing" procedure.
  void BasicCertificateProcessing(const ParsedCertificate &cert,
                                  bool is_target_cert,
                                  bool is_target_cert_issuer,
                                  const der::GeneralizedTime &time,
                                  KeyPurpose required_key_purpose,
                                  CertErrors *errors,
                                  bool *shortcircuit_chain_validation);

  // This function corresponds to RFC 5280 section 6.1.4's "Preparation for
  // Certificate i+1" procedure. |cert| is expected to be an intermediate.
  void PrepareForNextCertificate(const ParsedCertificate &cert,
                                 KeyPurpose key_purpose, CertErrors *errors);

  // This function corresponds with RFC 5280 section 6.1.5's "Wrap-Up
  // Procedure". It does processing for the final certificate (the target cert).
  void WrapUp(const ParsedCertificate &cert, KeyPurpose required_key_purpose,
              const std::set<der::Input> &user_initial_policy_set,
              bool allow_precertificate, CertErrors *errors);

  // Enforces trust anchor constraints compatible with RFC 5937.
  //
  // Note that the anchor constraints are encoded via the attached certificate
  // itself.
  void ApplyTrustAnchorConstraints(const ParsedCertificate &cert,
                                   KeyPurpose required_key_purpose,
                                   CertErrors *errors);

  // Initializes the path validation algorithm given anchor constraints. This
  // follows the description in RFC 5937
  void ProcessRootCertificate(const ParsedCertificate &cert,
                              const CertificateTrust &trust,
                              const der::GeneralizedTime &time,
                              KeyPurpose required_key_purpose,
                              CertErrors *errors,
                              bool *shortcircuit_chain_validation);

  // Processes verification when the input is a single certificate. This is not
  // defined by any standard. We attempt to match the de-facto behaviour of
  // Operating System verifiers.
  void ProcessSingleCertChain(const ParsedCertificate &cert,
                              const CertificateTrust &trust,
                              const der::GeneralizedTime &time,
                              KeyPurpose required_key_purpose,
                              CertErrors *errors);

  // Parses |spki| to an EVP_PKEY and checks whether the public key is accepted
  // by |delegate_|. On failure parsing returns nullptr. If either parsing the
  // key or key policy failed, adds a high-severity error to |errors|.
  bssl::UniquePtr<EVP_PKEY> ParseAndCheckPublicKey(der::Input spki,
                                                   CertErrors *errors);

  ValidPolicyGraph valid_policy_graph_;

  std::set<der::Input> user_constrained_policy_set_;

  // Will contain a NameConstraints for each previous cert in the chain which
  // had nameConstraints. This corresponds to the permitted_subtrees and
  // excluded_subtrees state variables from RFC 5280.
  std::vector<const NameConstraints *> name_constraints_list_;

  // |explicit_policy_| corresponds with the same named variable from RFC 5280
  // section 6.1.2:
  //
  //   explicit_policy:  an integer that indicates if a non-NULL
  //   valid_policy_tree is required.  The integer indicates the
  //   number of non-self-issued certificates to be processed before
  //   this requirement is imposed.  Once set, this variable may be
  //   decreased, but may not be increased.  That is, if a certificate in the
  //   path requires a non-NULL valid_policy_tree, a later certificate cannot
  //   remove this requirement.  If initial-explicit-policy is set, then the
  //   initial value is 0, otherwise the initial value is n+1.
  size_t explicit_policy_;

  // |inhibit_any_policy_| corresponds with the same named variable from RFC
  // 5280 section 6.1.2:
  //
  //   inhibit_anyPolicy:  an integer that indicates whether the
  //   anyPolicy policy identifier is considered a match.  The
  //   integer indicates the number of non-self-issued certificates
  //   to be processed before the anyPolicy OID, if asserted in a
  //   certificate other than an intermediate self-issued
  //   certificate, is ignored.  Once set, this variable may be
  //   decreased, but may not be increased.  That is, if a
  //   certificate in the path inhibits processing of anyPolicy, a
  //   later certificate cannot permit it.  If initial-any-policy-
  //   inhibit is set, then the initial value is 0, otherwise the
  //   initial value is n+1.
  size_t inhibit_any_policy_;

  // |policy_mapping_| corresponds with the same named variable from RFC 5280
  // section 6.1.2:
  //
  //   policy_mapping:  an integer that indicates if policy mapping
  //   is permitted.  The integer indicates the number of non-self-
  //   issued certificates to be processed before policy mapping is
  //   inhibited.  Once set, this variable may be decreased, but may
  //   not be increased.  That is, if a certificate in the path
  //   specifies that policy mapping is not permitted, it cannot be
  //   overridden by a later certificate.  If initial-policy-
  //   mapping-inhibit is set, then the initial value is 0,
  //   otherwise the initial value is n+1.
  size_t policy_mapping_;

  // |working_public_key_| is an amalgamation of 3 separate variables from RFC
  // 5280:
  //    * working_public_key
  //    * working_public_key_algorithm
  //    * working_public_key_parameters
  //
  // They are combined for simplicity since the signature verification takes an
  // EVP_PKEY, and the parameter inheritance is not applicable for the supported
  // key types. |working_public_key_| may be null if parsing failed.
  //
  // An approximate explanation of |working_public_key_| is this description
  // from RFC 5280 section 6.1.2:
  //
  //    working_public_key:  the public key used to verify the
  //    signature of a certificate.
  bssl::UniquePtr<EVP_PKEY> working_public_key_;

  // |working_normalized_issuer_name_| is the normalized value of the
  // working_issuer_name variable in RFC 5280 section 6.1.2:
  //
  //    working_issuer_name:  the issuer distinguished name expected
  //    in the next certificate in the chain.
  der::Input working_normalized_issuer_name_;

  // |max_path_length_| corresponds with the same named variable in RFC 5280
  // section 6.1.2.
  //
  //    max_path_length:  this integer is initialized to n, is
  //    decremented for each non-self-issued certificate in the path,
  //    and may be reduced to the value in the path length constraint
  //    field within the basic constraints extension of a CA
  //    certificate.
  size_t max_path_length_;

  VerifyCertificateChainDelegate *delegate_;
};

void PathVerifier::VerifyPolicies(const ParsedCertificate &cert,
                                  bool is_target_cert, CertErrors *errors) {
  // From RFC 5280 section 6.1.3:
  //
  //  (d)  If the certificate policies extension is present in the
  //       certificate and the valid_policy_tree is not NULL, process
  //       the policy information by performing the following steps in
  //       order:
  if (cert.has_policy_oids() && !valid_policy_graph_.IsNull()) {
    ValidPolicyGraph::LevelDetails previous_level =
        valid_policy_graph_.StartLevel();

    //     (1)  For each policy P not equal to anyPolicy in the
    //          certificate policies extension, let P-OID denote the OID
    //          for policy P and P-Q denote the qualifier set for policy
    //          P.  Perform the following steps in order:
    bool cert_has_any_policy = false;
    for (der::Input p_oid : cert.policy_oids()) {
      if (p_oid == der::Input(kAnyPolicyOid)) {
        cert_has_any_policy = true;
        continue;
      }

      //        (i)   For each node of depth i-1 in the valid_policy_tree
      //              where P-OID is in the expected_policy_set, create a
      //              child node as follows: set the valid_policy to P-OID,
      //              set the qualifier_set to P-Q, and set the
      //              expected_policy_set to {P-OID}.
      auto iter = previous_level.expected_policy_map.find(p_oid);
      if (iter != previous_level.expected_policy_map.end()) {
        valid_policy_graph_.AddNode(
            p_oid, /*parent_policies=*/std::move(iter->second));
        previous_level.expected_policy_map.erase(iter);
      } else if (previous_level.has_any_policy) {
        //      (ii)  If there was no match in step (i) and the
        //            valid_policy_tree includes a node of depth i-1 with
        //            the valid_policy anyPolicy, generate a child node with
        //            the following values: set the valid_policy to P-OID,
        //            set the qualifier_set to P-Q, and set the
        //            expected_policy_set to  {P-OID}.
        valid_policy_graph_.AddNodeWithParentAnyPolicy(p_oid);
      }
    }

    //     (2)  If the certificate policies extension includes the policy
    //          anyPolicy with the qualifier set AP-Q and either (a)
    //          inhibit_anyPolicy is greater than 0 or (b) i<n and the
    //          certificate is self-issued, then:
    //
    //          For each node in the valid_policy_tree of depth i-1, for
    //          each value in the expected_policy_set (including
    //          anyPolicy) that does not appear in a child node, create a
    //          child node with the following values: set the valid_policy
    //          to the value from the expected_policy_set in the parent
    //          node, set the qualifier_set to AP-Q, and set the
    //          expected_policy_set to the value in the valid_policy from
    //          this node.
    if (cert_has_any_policy && ((inhibit_any_policy_ > 0) ||
                                (!is_target_cert && IsSelfIssued(cert)))) {
      for (auto &[p_oid, parent_policies] :
           previous_level.expected_policy_map) {
        valid_policy_graph_.AddNode(p_oid, std::move(parent_policies));
      }
      if (previous_level.has_any_policy) {
        valid_policy_graph_.AddAnyPolicyNode();
      }
    }

    //     (3)  If there is a node in the valid_policy_tree of depth i-1
    //          or less without any child nodes, delete that node.  Repeat
    //          this step until there are no nodes of depth i-1 or less
    //          without children.
    //
    // This implementation does this as part of GetUserConstrainedPolicySet().
    // Only the current level needs to be pruned to compute the policy graph.
  }

  //  (e)  If the certificate policies extension is not present, set the
  //       valid_policy_tree to NULL.
  if (!cert.has_policy_oids()) {
    valid_policy_graph_.SetNull();
  }

  //  (f)  Verify that either explicit_policy is greater than 0 or the
  //       valid_policy_tree is not equal to NULL;
  if (!((explicit_policy_ > 0) || !valid_policy_graph_.IsNull())) {
    errors->AddError(cert_errors::kNoValidPolicy);
  }
}

void PathVerifier::VerifyPolicyMappings(const ParsedCertificate &cert,
                                        CertErrors *errors) {
  if (!cert.has_policy_mappings()) {
    return;
  }

  // From RFC 5280 section 6.1.4:
  //
  //  (a)  If a policy mappings extension is present, verify that the
  //       special value anyPolicy does not appear as an
  //       issuerDomainPolicy or a subjectDomainPolicy.
  for (const ParsedPolicyMapping &mapping : cert.policy_mappings()) {
    if (mapping.issuer_domain_policy == der::Input(kAnyPolicyOid) ||
        mapping.subject_domain_policy == der::Input(kAnyPolicyOid)) {
      // Because this implementation continues processing certificates after
      // this error, clear the valid policy graph to ensure the
      // "user_constrained_policy_set" output upon failure is empty.
      valid_policy_graph_.SetNull();
      errors->AddError(cert_errors::kPolicyMappingAnyPolicy);
      return;
    }
  }

  //  (b)  If a policy mappings extension is present, then for each
  //       issuerDomainPolicy ID-P in the policy mappings extension:
  //
  //     (1)  If the policy_mapping variable is greater than 0, for each
  //          node in the valid_policy_tree of depth i where ID-P is the
  //          valid_policy, set expected_policy_set to the set of
  //          subjectDomainPolicy values that are specified as
  //          equivalent to ID-P by the policy mappings extension.
  //
  //          If no node of depth i in the valid_policy_tree has a
  //          valid_policy of ID-P but there is a node of depth i with a
  //          valid_policy of anyPolicy, then generate a child node of
  //          the node of depth i-1 that has a valid_policy of anyPolicy
  //          as follows:
  //
  //        (i)    set the valid_policy to ID-P;
  //
  //        (ii)   set the qualifier_set to the qualifier set of the
  //               policy anyPolicy in the certificate policies
  //               extension of certificate i; and
  //
  //        (iii)  set the expected_policy_set to the set of
  //               subjectDomainPolicy values that are specified as
  //               equivalent to ID-P by the policy mappings extension.
  //
  if (policy_mapping_ > 0) {
    for (const ParsedPolicyMapping &mapping : cert.policy_mappings()) {
      valid_policy_graph_.AddPolicyMapping(mapping.issuer_domain_policy,
                                           mapping.subject_domain_policy);
    }
  }

  //  (b)  If a policy mappings extension is present, then for each
  //       issuerDomainPolicy ID-P in the policy mappings extension:
  //
  //  ...
  //
  //     (2)  If the policy_mapping variable is equal to 0:
  //
  //        (i)    delete each node of depth i in the valid_policy_tree
  //               where ID-P is the valid_policy.
  //
  //        (ii)   If there is a node in the valid_policy_tree of depth
  //               i-1 or less without any child nodes, delete that
  //               node.  Repeat this step until there are no nodes of
  //               depth i-1 or less without children.
  //
  // Step (ii) is deferred to part of GetUserConstrainedPolicySet().
  if (policy_mapping_ == 0) {
    for (const ParsedPolicyMapping &mapping : cert.policy_mappings()) {
      valid_policy_graph_.DeleteNode(mapping.issuer_domain_policy);
    }
  }
}

void PathVerifier::ApplyPolicyConstraints(const ParsedCertificate &cert) {
  // RFC 5280 section 6.1.4 step i-j:
  //      (i)  If a policy constraints extension is included in the
  //           certificate, modify the explicit_policy and policy_mapping
  //           state variables as follows:
  if (cert.has_policy_constraints()) {
    //         (1)  If requireExplicitPolicy is present and is less than
    //              explicit_policy, set explicit_policy to the value of
    //              requireExplicitPolicy.
    if (cert.policy_constraints().require_explicit_policy &&
        cert.policy_constraints().require_explicit_policy.value() <
            explicit_policy_) {
      explicit_policy_ =
          cert.policy_constraints().require_explicit_policy.value();
    }

    //         (2)  If inhibitPolicyMapping is present and is less than
    //              policy_mapping, set policy_mapping to the value of
    //              inhibitPolicyMapping.
    if (cert.policy_constraints().inhibit_policy_mapping &&
        cert.policy_constraints().inhibit_policy_mapping.value() <
            policy_mapping_) {
      policy_mapping_ =
          cert.policy_constraints().inhibit_policy_mapping.value();
    }
  }

  //      (j)  If the inhibitAnyPolicy extension is included in the
  //           certificate and is less than inhibit_anyPolicy, set
  //           inhibit_anyPolicy to the value of inhibitAnyPolicy.
  if (cert.inhibit_any_policy() &&
      cert.inhibit_any_policy().value() < inhibit_any_policy_) {
    inhibit_any_policy_ = cert.inhibit_any_policy().value();
  }
}

void PathVerifier::BasicCertificateProcessing(
    const ParsedCertificate &cert, bool is_target_cert,
    bool is_target_cert_issuer, const der::GeneralizedTime &time,
    KeyPurpose required_key_purpose, CertErrors *errors,
    bool *shortcircuit_chain_validation) {
  *shortcircuit_chain_validation = false;
  // Check that the signature algorithms in Certificate vs TBSCertificate
  // match. This isn't part of RFC 5280 section 6.1.3, but is mandated by
  // sections 4.1.1.2 and 4.1.2.3.
  if (!VerifySignatureAlgorithmsMatch(cert, errors)) {
    BSSL_CHECK(errors->ContainsAnyErrorWithSeverity(CertError::SEVERITY_HIGH));
    *shortcircuit_chain_validation = true;
  }

  // Check whether this signature algorithm is allowed.
  if (!cert.signature_algorithm().has_value() ||
      !delegate_->IsSignatureAlgorithmAcceptable(*cert.signature_algorithm(),
                                                 errors)) {
    *shortcircuit_chain_validation = true;
    errors->AddError(cert_errors::kUnacceptableSignatureAlgorithm);
    return;
  }

  if (working_public_key_) {
    // Verify the digital signature using the previous certificate's key (RFC
    // 5280 section 6.1.3 step a.1).
    if (!VerifySignedData(*cert.signature_algorithm(),
                          cert.tbs_certificate_tlv(), cert.signature_value(),
                          working_public_key_.get(),
                          delegate_->GetVerifyCache())) {
      *shortcircuit_chain_validation = true;
      errors->AddError(cert_errors::kVerifySignedDataFailed);
    }
  } else {
    // If `working_public_key_` is null, that indicates the SPKI of the issuer
    // could not be parsed. Handle this the same way as an invalid signature by
    // shortcircuiting the rest of verification.
    // An error should already have been added by ParseAndCheckPublicKey, but
    // it's added on the CertErrors for the issuer, so we can't BSSL_CHECK
    // errors->ContainsAnyErrorWithSeverity here. (It will be BSSL_CHECKed when
    // the shortcircuit_chain_validation is acted on in PathVerifier::Run.)
    *shortcircuit_chain_validation = true;
  }
  if (*shortcircuit_chain_validation) {
    return;
  }

  // Check the time range for the certificate's validity, ensuring it is valid
  // at |time|.
  // (RFC 5280 section 6.1.3 step a.2)
  VerifyTimeValidity(cert, time, errors);

  // RFC 5280 section 6.1.3 step a.3 calls for checking the certificate's
  // revocation status here. In this implementation revocation checking is
  // implemented separately from path validation.

  // Verify the certificate's issuer name matches the issuing certificate's
  // subject name. (RFC 5280 section 6.1.3 step a.4)
  if (cert.normalized_issuer() != working_normalized_issuer_name_) {
    errors->AddError(cert_errors::kSubjectDoesNotMatchIssuer);
  }

  // Name constraints (RFC 5280 section 6.1.3 step b & c)
  // If certificate i is self-issued and it is not the final certificate in the
  // path, skip this step for certificate i.
  if (!name_constraints_list_.empty() &&
      (!IsSelfIssued(cert) || is_target_cert)) {
    for (const NameConstraints *nc : name_constraints_list_) {
      nc->IsPermittedCert(cert.normalized_subject(), cert.subject_alt_names(),
                          errors);
    }
  }

  // RFC 5280 section 6.1.3 step d - f.
  VerifyPolicies(cert, is_target_cert, errors);

  // The key purpose is checked not just for the end-entity certificate, but
  // also interpreted as a constraint when it appears in intermediates. This
  // goes beyond what RFC 5280 describes, but is the de-facto standard. See
  // https://wiki.mozilla.org/CA/CertificatePolicyV2.1#Frequently_Asked_Questions
  VerifyExtendedKeyUsage(cert, required_key_purpose, errors, is_target_cert,
                         is_target_cert_issuer);
}

void PathVerifier::PrepareForNextCertificate(const ParsedCertificate &cert,
                                             KeyPurpose key_purpose,
                                             CertErrors *errors) {
  // RFC 5280 section 6.1.4 step a-b
  VerifyPolicyMappings(cert, errors);

  // From RFC 5280 section 6.1.4 step c:
  //
  //    Assign the certificate subject name to working_normalized_issuer_name.
  working_normalized_issuer_name_ = cert.normalized_subject();

  // From RFC 5280 section 6.1.4 step d:
  //
  //    Assign the certificate subjectPublicKey to working_public_key.
  working_public_key_ = ParseAndCheckPublicKey(cert.tbs().spki_tlv, errors);

  // Note that steps e and f are omitted as they are handled by
  // the assignment to |working_spki| above. See the definition
  // of |working_spki|.

  // From RFC 5280 section 6.1.4 step g:
  if (cert.has_name_constraints()) {
    name_constraints_list_.push_back(&cert.name_constraints());
  }

  //     (h)  If certificate i is not self-issued:
  if (!IsSelfIssued(cert)) {
    //         (1)  If explicit_policy is not 0, decrement explicit_policy by
    //              1.
    if (explicit_policy_ > 0) {
      explicit_policy_ -= 1;
    }

    //         (2)  If policy_mapping is not 0, decrement policy_mapping by 1.
    if (policy_mapping_ > 0) {
      policy_mapping_ -= 1;
    }

    //         (3)  If inhibit_anyPolicy is not 0, decrement inhibit_anyPolicy
    //              by 1.
    if (inhibit_any_policy_ > 0) {
      inhibit_any_policy_ -= 1;
    }
  }

  // RFC 5280 section 6.1.4 step i-j:
  ApplyPolicyConstraints(cert);

  // From RFC 5280 section 6.1.4 step k:
  //
  //    If certificate i is a version 3 certificate, verify that the
  //    basicConstraints extension is present and that cA is set to
  //    TRUE.  (If certificate i is a version 1 or version 2
  //    certificate, then the application MUST either verify that
  //    certificate i is a CA certificate through out-of-band means
  //    or reject the certificate.  Conforming implementations may
  //    choose to reject all version 1 and version 2 intermediate
  //    certificates.)
  //
  // This code implicitly rejects non version 3 intermediates, since they
  // can't contain a BasicConstraints extension.
  if (!cert.has_basic_constraints()) {
    errors->AddError(cert_errors::kMissingBasicConstraints);
  } else if (!cert.basic_constraints().is_ca) {
    errors->AddError(cert_errors::kBasicConstraintsIndicatesNotCa);
  }

  // From RFC 5280 section 6.1.4 step l:
  //
  //    If the certificate was not self-issued, verify that
  //    max_path_length is greater than zero and decrement
  //    max_path_length by 1.
  if (!IsSelfIssued(cert)) {
    if (max_path_length_ == 0) {
      errors->AddError(cert_errors::kMaxPathLengthViolated);
    } else {
      --max_path_length_;
    }
  }

  // From RFC 5280 section 6.1.4 step m:
  //
  //    If pathLenConstraint is present in the certificate and is
  //    less than max_path_length, set max_path_length to the value
  //    of pathLenConstraint.
  if (cert.has_basic_constraints() && cert.basic_constraints().has_path_len &&
      cert.basic_constraints().path_len < max_path_length_) {
    max_path_length_ = cert.basic_constraints().path_len;
  }

  // From RFC 5280 section 6.1.4 step n:
  //
  //    If a key usage extension is present, verify that the
  //    keyCertSign bit is set.
  if (cert.has_key_usage() &&
      !cert.key_usage().AssertsBit(KEY_USAGE_BIT_KEY_CERT_SIGN)) {
    errors->AddError(cert_errors::kKeyCertSignBitNotSet);
  }

  // From RFC 5280 section 6.1.4 step o:
  //
  //    Recognize and process any other critical extension present in
  //    the certificate.  Process any other recognized non-critical
  //    extension present in the certificate that is relevant to path
  //    processing.
  VerifyNoUnconsumedCriticalExtensions(
      cert, errors, delegate_->AcceptPreCertificates(), key_purpose);
}

// Checks if the target certificate has the CA bit set. If it does, add
// the appropriate error or warning to |errors|.
void VerifyTargetCertIsNotCA(const ParsedCertificate &cert,
                             KeyPurpose required_key_purpose,
                             CertErrors *errors) {
  if (cert.has_basic_constraints() && cert.basic_constraints().is_ca) {
    // In spite of RFC 5280 4.2.1.9 which says the CA properties MAY exist in
    // an end entity certificate, the CABF Baseline Requirements version
    // 1.8.4, 7.1.2.3(d) prohibit the CA bit being set in an end entity
    // certificate.
    switch (required_key_purpose) {
      case KeyPurpose::ANY_EKU:
        break;
      case KeyPurpose::SERVER_AUTH:
      case KeyPurpose::CLIENT_AUTH:
        errors->AddWarning(cert_errors::kTargetCertShouldNotBeCa);
        break;
      case KeyPurpose::SERVER_AUTH_STRICT:
      case KeyPurpose::CLIENT_AUTH_STRICT:
      case KeyPurpose::CLIENT_AUTH_STRICT_LEAF:
      case KeyPurpose::SERVER_AUTH_STRICT_LEAF:
      case KeyPurpose::RCS_MLS_CLIENT_AUTH:
      case KeyPurpose::C2PA_TIMESTAMPING:
      case KeyPurpose::C2PA_MANIFEST:
        errors->AddError(cert_errors::kTargetCertShouldNotBeCa);
        break;
    }
  }
}

void PathVerifier::WrapUp(const ParsedCertificate &cert,
                          KeyPurpose required_key_purpose,
                          const std::set<der::Input> &user_initial_policy_set,
                          bool allow_precertificate,
                          CertErrors * errors) {
  // From RFC 5280 section 6.1.5:
  //      (a)  If explicit_policy is not 0, decrement explicit_policy by 1.
  if (explicit_policy_ > 0) {
    explicit_policy_ -= 1;
  }

  //      (b)  If a policy constraints extension is included in the
  //           certificate and requireExplicitPolicy is present and has a
  //           value of 0, set the explicit_policy state variable to 0.
  if (cert.has_policy_constraints() &&
      cert.policy_constraints().require_explicit_policy.has_value() &&
      cert.policy_constraints().require_explicit_policy == 0) {
    explicit_policy_ = 0;
  }

  // Note step c-e are omitted as the verification function does
  // not output the working public key.

  // From RFC 5280 section 6.1.5 step f:
  //
  //    Recognize and process any other critical extension present in
  //    the certificate n.  Process any other recognized non-critical
  //    extension present in certificate n that is relevant to path
  //    processing.
  //
  // Note that this is duplicated by PrepareForNextCertificate() so as to
  // directly match the procedures in RFC 5280's section 6.1.
  VerifyNoUnconsumedCriticalExtensions(cert, errors, allow_precertificate,
                                       required_key_purpose);

  // This calculates the intersection from RFC 5280 section 6.1.5 step g, as
  // well as applying the deferred recursive node that were skipped earlier in
  // the process.
  user_constrained_policy_set_ =
      valid_policy_graph_.GetUserConstrainedPolicySet(user_initial_policy_set);

  // From RFC 5280 section 6.1.5 step g:
  //
  //    If either (1) the value of explicit_policy variable is greater than
  //    zero or (2) the valid_policy_tree is not NULL, then path processing
  //    has succeeded.
  if (explicit_policy_ == 0 && user_constrained_policy_set_.empty()) {
    errors->AddError(cert_errors::kNoValidPolicy);
  }

  // The following check is NOT part of RFC 5280 6.1.5's "Wrap-Up Procedure",
  // however is implied by RFC 5280 section 4.2.1.9, as well as CABF Base
  // Requirements.
  VerifyTargetCertIsNotCA(cert, required_key_purpose, errors);

  // Check the public key for the target certificate. The public key for the
  // other certificates is already checked by PrepareForNextCertificate().
  // Note that this step is not part of RFC 5280 6.1.5.
  ParseAndCheckPublicKey(cert.tbs().spki_tlv, errors);
}

void PathVerifier::ApplyTrustAnchorConstraints(const ParsedCertificate &cert,
                                               KeyPurpose required_key_purpose,
                                               CertErrors *errors) {
  // If certificatePolicies is present, process the policies. This matches the
  // handling for intermediates from RFC 5280 section 6.1.3.d (except that for
  // intermediates it is non-optional). It intentionally deviates from RFC 5937
  // section 3.2 which says to intersect with user-initial-policy-set, since
  // processing as part of user-initial-policy-set has subtly different
  // semantics from being handled as part of the chain processing (see
  // https://crbug.com/1403258).
  if (cert.has_policy_oids()) {
    VerifyPolicies(cert, /*is_target_cert=*/false, errors);
  }

  // Process policyMappings, if present. This matches the handling for
  // intermediates from RFC 5280 section 6.1.4 step a-b.
  VerifyPolicyMappings(cert, errors);

  // Process policyConstraints and inhibitAnyPolicy. This matches the
  // handling for intermediates from RFC 5280 section 6.1.4 step i-j.
  // This intentionally deviates from RFC 5937 section 3.2 which says to
  // initialize the initial-any-policy-inhibit, initial-explicit-policy, and/or
  // initial-policy-mapping-inhibit inputs to verification. Those are all
  // bools, so they cannot properly represent the constraints encoded in the
  // policyConstraints and inhibitAnyPolicy extensions.
  ApplyPolicyConstraints(cert);

  // If keyUsage is present, verify that |cert| has correct keyUsage bits for a
  // CA. This matches the handling for intermediates from RFC 5280 section
  // 6.1.4 step n.
  if (cert.has_key_usage() &&
      !cert.key_usage().AssertsBit(KEY_USAGE_BIT_KEY_CERT_SIGN)) {
    errors->AddError(cert_errors::kKeyCertSignBitNotSet);
  }

  // This is not part of RFC 5937 nor RFC 5280, but matches the EKU handling
  // done for intermediates (described in Web PKI's Baseline Requirements).
  VerifyExtendedKeyUsage(cert, required_key_purpose, errors,
                         /*is_target_cert=*/false,
                         /*is_target_cert_issuer=*/false);

  // The following enforcements follow from RFC 5937 (primarily section 3.2):

  // Initialize name constraints initial-permitted/excluded-subtrees.
  if (cert.has_name_constraints()) {
    name_constraints_list_.push_back(&cert.name_constraints());
  }

  if (cert.has_basic_constraints()) {
    // Enforce CA=true if basicConstraints is present. This matches behavior of
    // other verifiers, and seems like a good thing to do to avoid a
    // certificate being used in the wrong context if it was specifically
    // marked as not being a CA.
    if (!cert.basic_constraints().is_ca) {
      errors->AddError(cert_errors::kBasicConstraintsIndicatesNotCa);
    }
    // From RFC 5937 section 3.2:
    //
    //    If a basic constraints extension is associated with the trust
    //    anchor and contains a pathLenConstraint value, set the
    //    max_path_length state variable equal to the pathLenConstraint
    //    value from the basic constraints extension.
    //
    if (cert.basic_constraints().has_path_len) {
      max_path_length_ = cert.basic_constraints().path_len;
    }
  }

  // From RFC 5937 section 2:
  //
  //    Extensions may be marked critical or not critical.  When trust anchor
  //    constraints are enforced, clients MUST reject certification paths
  //    containing a trust anchor with unrecognized critical extensions.
  VerifyNoUnconsumedCriticalExtensions(cert, errors,
                                       /*allow_precertificate=*/false,
                                       required_key_purpose);
}

void PathVerifier::ProcessRootCertificate(const ParsedCertificate &cert,
                                          const CertificateTrust &trust,
                                          const der::GeneralizedTime &time,
                                          KeyPurpose required_key_purpose,
                                          CertErrors *errors,
                                          bool *shortcircuit_chain_validation) {
  *shortcircuit_chain_validation = false;
  switch (trust.type) {
    case CertificateTrustType::UNSPECIFIED:
    case CertificateTrustType::TRUSTED_LEAF:
      // Doesn't chain to a trust anchor - implicitly distrusted
      errors->AddError(cert_errors::kCertIsNotTrustAnchor);
      *shortcircuit_chain_validation = true;
      break;
    case CertificateTrustType::DISTRUSTED:
      // Chains to an actively distrusted certificate.
      errors->AddError(cert_errors::kDistrustedByTrustStore);
      *shortcircuit_chain_validation = true;
      break;
    case CertificateTrustType::TRUSTED_ANCHOR:
    case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
      break;
  }
  if (*shortcircuit_chain_validation) {
    return;
  }

  if (trust.enforce_anchor_expiry) {
    VerifyTimeValidity(cert, time, errors);
  }
  if (trust.enforce_anchor_constraints) {
    if (trust.require_anchor_basic_constraints &&
        !cert.has_basic_constraints()) {
      switch (cert.tbs().version) {
        case CertificateVersion::V1:
        case CertificateVersion::V2:
          break;
        case CertificateVersion::V3:
          errors->AddError(cert_errors::kMissingBasicConstraints);
          break;
      }
    }
    ApplyTrustAnchorConstraints(cert, required_key_purpose, errors);
  }

  // Use the certificate's SPKI and subject when verifying the next certificate.
  working_public_key_ = ParseAndCheckPublicKey(cert.tbs().spki_tlv, errors);
  working_normalized_issuer_name_ = cert.normalized_subject();
}

void PathVerifier::ProcessSingleCertChain(const ParsedCertificate &cert,
                                          const CertificateTrust &trust,
                                          const der::GeneralizedTime &time,
                                          KeyPurpose required_key_purpose,
                                          CertErrors *errors) {
  switch (trust.type) {
    case CertificateTrustType::UNSPECIFIED:
    case CertificateTrustType::TRUSTED_ANCHOR:
      // Target doesn't have a chain and isn't a directly trusted leaf -
      // implicitly distrusted.
      errors->AddError(cert_errors::kCertIsNotTrustAnchor);
      return;
    case CertificateTrustType::DISTRUSTED:
      // Target is directly distrusted.
      errors->AddError(cert_errors::kDistrustedByTrustStore);
      return;
    case CertificateTrustType::TRUSTED_LEAF:
    case CertificateTrustType::TRUSTED_ANCHOR_OR_LEAF:
      break;
  }

  // Check the public key for the target certificate regardless of whether
  // `require_leaf_selfsigned` is true. This matches the check in WrapUp and
  // fulfills the documented behavior of the IsPublicKeyAcceptable delegate.
  ParseAndCheckPublicKey(cert.tbs().spki_tlv, errors);

  if (trust.require_leaf_selfsigned) {
    if (!VerifyCertificateIsSelfSigned(cert, delegate_->GetVerifyCache(),
                                       errors)) {
      // VerifyCertificateIsSelfSigned should have added an error, but just
      // double check to be safe.
      if (!errors->ContainsAnyErrorWithSeverity(CertError::SEVERITY_HIGH)) {
        errors->AddError(cert_errors::kInternalError);
      }
      return;
    }
  }

  // There is no standard for what it means to verify a directly trusted leaf
  // certificate, so this is basically just checking common sense things that
  // also mirror what we observed to be enforced with the Operating System
  // native verifiers.
  VerifyTimeValidity(cert, time, errors);
  VerifyExtendedKeyUsage(cert, required_key_purpose, errors,
                         /*is_target_cert=*/true,
                         /*is_target_cert_issuer=*/false);

  // Checking for unknown critical extensions matches Windows, but is stricter
  // than the Mac verifier.
  VerifyNoUnconsumedCriticalExtensions(cert, errors,
                                       /*allow_precertificate=*/false,
                                       required_key_purpose);
}

bssl::UniquePtr<EVP_PKEY> PathVerifier::ParseAndCheckPublicKey(
    der::Input spki, CertErrors *errors) {
  // Parse the public key.
  bssl::UniquePtr<EVP_PKEY> pkey;
  if (!ParsePublicKey(spki, &pkey)) {
    errors->AddError(cert_errors::kFailedParsingSpki);
    return nullptr;
  }

  // Check if the key is acceptable by the delegate.
  if (!delegate_->IsPublicKeyAcceptable(pkey.get(), errors)) {
    errors->AddError(cert_errors::kUnacceptablePublicKey);
  }

  return pkey;
}

void PathVerifier::Run(
    const ParsedCertificateList &certs, const CertificateTrust &last_cert_trust,
    VerifyCertificateChainDelegate *delegate, const der::GeneralizedTime &time,
    KeyPurpose required_key_purpose,
    InitialExplicitPolicy initial_explicit_policy,
    const std::set<der::Input> &user_initial_policy_set,
    InitialPolicyMappingInhibit initial_policy_mapping_inhibit,
    InitialAnyPolicyInhibit initial_any_policy_inhibit,
    std::set<der::Input> *user_constrained_policy_set, CertPathErrors *errors) {
  // This implementation is structured to mimic the description of certificate
  // path verification given by RFC 5280 section 6.1.
  BSSL_CHECK(delegate);
  BSSL_CHECK(errors);

  delegate_ = delegate;

  // An empty chain is necessarily invalid.
  if (certs.empty()) {
    errors->GetOtherErrors()->AddError(cert_errors::kChainIsEmpty);
    return;
  }

  // Verifying a trusted leaf certificate isn't a well-specified operation, so
  // it's handled separately from the RFC 5280 defined verification process.
  if (certs.size() == 1) {
    ProcessSingleCertChain(*certs.front(), last_cert_trust, time,
                           required_key_purpose, errors->GetErrorsForCert(0));
    return;
  }

  // RFC 5280's "n" variable is the length of the path, which does not count
  // the trust anchor. (Although in practice it doesn't really change behaviors
  // if n is used in place of n+1).
  const size_t n = certs.size() - 1;

  valid_policy_graph_.Init();

  // RFC 5280 section section 6.1.2:
  //
  // If initial-explicit-policy is set, then the initial value
  // [of explicit_policy] is 0, otherwise the initial value is n+1.
  explicit_policy_ =
      initial_explicit_policy == InitialExplicitPolicy::kTrue ? 0 : n + 1;

  // RFC 5280 section section 6.1.2:
  //
  // If initial-any-policy-inhibit is set, then the initial value
  // [of inhibit_anyPolicy] is 0, otherwise the initial value is n+1.
  inhibit_any_policy_ =
      initial_any_policy_inhibit == InitialAnyPolicyInhibit::kTrue ? 0 : n + 1;

  // RFC 5280 section section 6.1.2:
  //
  // If initial-policy-mapping-inhibit is set, then the initial value
  // [of policy_mapping] is 0, otherwise the initial value is n+1.
  policy_mapping_ =
      initial_policy_mapping_inhibit == InitialPolicyMappingInhibit::kTrue
          ? 0
          : n + 1;

  // RFC 5280 section section 6.1.2:
  //
  // max_path_length:  this integer is initialized to n, ...
  max_path_length_ = n;

  // Iterate over all the certificates in the reverse direction: starting from
  // the root certificate and progressing towards the target certificate.
  //
  //   * i=0  :  Root certificate (i.e. trust anchor)
  //   * i=1  :  Certificate issued by root
  //   * i=x  :  Certificate i=x is issued by certificate i=x-1
  //   * i=n  :  Target certificate.
  for (size_t i = 0; i < certs.size(); ++i) {
    const size_t index_into_certs = certs.size() - i - 1;

    // |is_target_cert| is true if the current certificate is the target
    // certificate being verified. The target certificate isn't necessarily an
    // end-entity certificate.
    const bool is_target_cert = index_into_certs == 0;
    const bool is_target_cert_issuer = index_into_certs == 1;
    const bool is_root_cert = i == 0;

    const ParsedCertificate &cert = *certs[index_into_certs];

    // Output errors for the current certificate into an error bucket that is
    // associated with that certificate.
    CertErrors *cert_errors = errors->GetErrorsForCert(index_into_certs);

    if (is_root_cert) {
      bool shortcircuit_chain_validation = false;
      ProcessRootCertificate(cert, last_cert_trust, time, required_key_purpose,
                             cert_errors, &shortcircuit_chain_validation);
      if (shortcircuit_chain_validation) {
        // Chains that don't start from a trusted root should short-circuit the
        // rest of the verification, as accumulating more errors from untrusted
        // certificates would not be meaningful.
        BSSL_CHECK(cert_errors->ContainsAnyErrorWithSeverity(
            CertError::SEVERITY_HIGH));
        return;
      }

      // Don't do any other checks for root certificates.
      continue;
    }

    bool shortcircuit_chain_validation = false;
    // Per RFC 5280 section 6.1:
    //  * Do basic processing for each certificate
    //  * If it is the last certificate in the path (target certificate)
    //     - Then run "Wrap up"
    //     - Otherwise run "Prepare for Next cert"
    BasicCertificateProcessing(cert, is_target_cert, is_target_cert_issuer,
                               time, required_key_purpose, cert_errors,
                               &shortcircuit_chain_validation);
    if (shortcircuit_chain_validation) {
      // Signature errors or unparsable SPKIs should short-circuit the rest of
      // the verification, as accumulating more errors from untrusted
      // certificates would not be meaningful.
      BSSL_CHECK(
          errors->ContainsAnyErrorWithSeverity(CertError::SEVERITY_HIGH));
      return;
    }
    if (!is_target_cert) {
      PrepareForNextCertificate(cert, required_key_purpose, cert_errors);
    } else {
      WrapUp(cert, required_key_purpose, user_initial_policy_set,
             delegate->AcceptPreCertificates(), cert_errors);
    }
  }

  if (user_constrained_policy_set) {
    *user_constrained_policy_set = user_constrained_policy_set_;
  }

  // TODO(eroman): RFC 5280 forbids duplicate certificates per section 6.1:
  //
  //    A certificate MUST NOT appear more than once in a prospective
  //    certification path.
}

}  // namespace

VerifyCertificateChainDelegate::~VerifyCertificateChainDelegate() = default;

void VerifyCertificateChain(
    const ParsedCertificateList &certs, const CertificateTrust &last_cert_trust,
    VerifyCertificateChainDelegate *delegate, const der::GeneralizedTime &time,
    KeyPurpose required_key_purpose,
    InitialExplicitPolicy initial_explicit_policy,
    const std::set<der::Input> &user_initial_policy_set,
    InitialPolicyMappingInhibit initial_policy_mapping_inhibit,
    InitialAnyPolicyInhibit initial_any_policy_inhibit,
    std::set<der::Input> *user_constrained_policy_set, CertPathErrors *errors) {
  PathVerifier verifier;
  verifier.Run(certs, last_cert_trust, delegate, time, required_key_purpose,
               initial_explicit_policy, user_initial_policy_set,
               initial_policy_mapping_inhibit, initial_any_policy_inhibit,
               user_constrained_policy_set, errors);
}

bool VerifyCertificateIsSelfSigned(const ParsedCertificate &cert,
                                   SignatureVerifyCache *cache,
                                   CertErrors *errors) {
  if (cert.normalized_subject() != cert.normalized_issuer()) {
    if (errors) {
      errors->AddError(cert_errors::kSubjectDoesNotMatchIssuer);
    }
    return false;
  }

  // Note that we do not restrict the available algorithms when determining if
  // something is a self-signed cert. The signature isn't very important on a
  // self-signed cert so just allow any supported algorithm here, to avoid
  // breakage.
  if (!cert.signature_algorithm().has_value()) {
    if (errors) {
      errors->AddError(cert_errors::kUnacceptableSignatureAlgorithm);
    }
    return false;
  }

  if (!VerifySignedData(*cert.signature_algorithm(), cert.tbs_certificate_tlv(),
                        cert.signature_value(), cert.tbs().spki_tlv, cache)) {
    if (errors) {
      errors->AddError(cert_errors::kVerifySignedDataFailed);
    }
    return false;
  }

  return true;
}

BSSL_NAMESPACE_END
