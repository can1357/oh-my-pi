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

#include <algorithm>

#include "certificate_policies.h"

#include <openssl/base.h>
#include "cert_error_params.h"
#include "cert_errors.h"
#include "input.h"
#include "parse_values.h"
#include "parser.h"

BSSL_NAMESPACE_BEGIN

namespace {

// ---------------------------------------------------------------
// Errors
// ---------------------------------------------------------------

DEFINE_CERT_ERROR_ID(kPolicyQualifiersEmptySequence,
                     "The policy qualifiers SEQUENCE is empty");
DEFINE_CERT_ERROR_ID(kUnknownPolicyQualifierOid,
                     "Unknown policy qualifier OID (not CPS or User Notice)");
DEFINE_CERT_ERROR_ID(kPoliciesEmptySequence, "Policies is an empty SEQUENCE");
DEFINE_CERT_ERROR_ID(kPoliciesDuplicateOid, "Policies contains duplicate OIDs");
DEFINE_CERT_ERROR_ID(kPolicyInformationTrailingData,
                     "PolicyInformation has trailing data");
DEFINE_CERT_ERROR_ID(kFailedParsingPolicyQualifiers,
                     "Failed parsing policy qualifiers");
DEFINE_CERT_ERROR_ID(kMissingQualifier,
                     "PolicyQualifierInfo is missing qualifier");
DEFINE_CERT_ERROR_ID(kPolicyQualifierInfoTrailingData,
                     "PolicyQualifierInfo has trailing data");

// Minimally parse policyQualifiers, storing in |policy_qualifiers| if non-null.
// If a policy qualifier other than User Notice/CPS is present, parsing
// will fail if |restrict_to_known_qualifiers| was set to true.
bool ParsePolicyQualifiers(bool restrict_to_known_qualifiers,
                           der::Parser *policy_qualifiers_sequence_parser,
                           std::vector<PolicyQualifierInfo> *policy_qualifiers,
                           CertErrors *errors) {
  BSSL_CHECK(errors);

  // If it is present, the policyQualifiers sequence should have at least 1
  // element.
  //
  //      policyQualifiers   SEQUENCE SIZE (1..MAX) OF
  //                              PolicyQualifierInfo OPTIONAL }
  if (!policy_qualifiers_sequence_parser->HasMore()) {
    errors->AddError(kPolicyQualifiersEmptySequence);
    return false;
  }
  while (policy_qualifiers_sequence_parser->HasMore()) {
    // PolicyQualifierInfo ::= SEQUENCE {
    der::Parser policy_information_parser;
    if (!policy_qualifiers_sequence_parser->ReadSequence(
            &policy_information_parser)) {
      return false;
    }
    //      policyQualifierId  PolicyQualifierId,
    der::Input qualifier_oid;
    if (!policy_information_parser.ReadTag(CBS_ASN1_OBJECT, &qualifier_oid)) {
      return false;
    }
    if (restrict_to_known_qualifiers &&
        qualifier_oid != der::Input(kCpsPointerId) &&
        qualifier_oid != der::Input(kUserNoticeId)) {
      errors->AddError(kUnknownPolicyQualifierOid,
                       CreateCertErrorParams1Der("oid", qualifier_oid));
      return false;
    }
    //      qualifier          ANY DEFINED BY policyQualifierId }
    der::Input qualifier_tlv;
    if (!policy_information_parser.ReadRawTLV(&qualifier_tlv)) {
      errors->AddError(kMissingQualifier);
      return false;
    }
    // Should not have trailing data after qualifier.
    if (policy_information_parser.HasMore()) {
      errors->AddError(kPolicyQualifierInfoTrailingData);
      return false;
    }

    if (policy_qualifiers) {
      policy_qualifiers->push_back({qualifier_oid, qualifier_tlv});
    }
  }
  return true;
}

// RFC 5280 section 4.2.1.4.  Certificate Policies:
//
// certificatePolicies ::= SEQUENCE SIZE (1..MAX) OF PolicyInformation
//
// PolicyInformation ::= SEQUENCE {
//      policyIdentifier   CertPolicyId,
//      policyQualifiers   SEQUENCE SIZE (1..MAX) OF
//                              PolicyQualifierInfo OPTIONAL }
//
// CertPolicyId ::= OBJECT IDENTIFIER
//
// PolicyQualifierInfo ::= SEQUENCE {
//      policyQualifierId  PolicyQualifierId,
//      qualifier          ANY DEFINED BY policyQualifierId }
//
// PolicyQualifierId ::= OBJECT IDENTIFIER ( id-qt-cps | id-qt-unotice )
//
// Qualifier ::= CHOICE {
//      cPSuri           CPSuri,
//      userNotice       UserNotice }
//
// CPSuri ::= IA5String
//
// UserNotice ::= SEQUENCE {
//      noticeRef        NoticeReference OPTIONAL,
//      explicitText     DisplayText OPTIONAL }
//
// NoticeReference ::= SEQUENCE {
//      organization     DisplayText,
//      noticeNumbers    SEQUENCE OF INTEGER }
//
// DisplayText ::= CHOICE {
//      ia5String        IA5String      (SIZE (1..200)),
//      visibleString    VisibleString  (SIZE (1..200)),
//      bmpString        BMPString      (SIZE (1..200)),
//      utf8String       UTF8String     (SIZE (1..200)) }
bool ParseCertificatePoliciesExtensionImpl(
    der::Input extension_value, bool fail_parsing_unknown_qualifier_oids,
    std::vector<der::Input> *policy_oids,
    std::vector<PolicyInformation> *policy_informations, CertErrors *errors) {
  BSSL_CHECK(policy_oids);
  BSSL_CHECK(errors);
  // certificatePolicies ::= SEQUENCE SIZE (1..MAX) OF PolicyInformation
  der::Parser extension_parser(extension_value);
  der::Parser policies_sequence_parser;
  if (!extension_parser.ReadSequence(&policies_sequence_parser)) {
    return false;
  }
  // Should not have trailing data after certificatePolicies sequence.
  if (extension_parser.HasMore()) {
    return false;
  }
  // The certificatePolicies sequence should have at least 1 element.
  if (!policies_sequence_parser.HasMore()) {
    errors->AddError(kPoliciesEmptySequence);
    return false;
  }

  policy_oids->clear();
  if (policy_informations) {
    policy_informations->clear();
  }

  while (policies_sequence_parser.HasMore()) {
    // PolicyInformation ::= SEQUENCE {
    der::Parser policy_information_parser;
    if (!policies_sequence_parser.ReadSequence(&policy_information_parser)) {
      return false;
    }
    //      policyIdentifier   CertPolicyId,
    der::Input policy_oid;
    if (!policy_information_parser.ReadTag(CBS_ASN1_OBJECT, &policy_oid)) {
      return false;
    }

    policy_oids->push_back(policy_oid);

    std::vector<PolicyQualifierInfo> *policy_qualifiers = nullptr;
    if (policy_informations) {
      policy_informations->emplace_back();
      policy_informations->back().policy_oid = policy_oid;
      policy_qualifiers = &policy_informations->back().policy_qualifiers;
    }

    if (!policy_information_parser.HasMore()) {
      continue;
    }

    //      policyQualifiers   SEQUENCE SIZE (1..MAX) OF
    //                              PolicyQualifierInfo OPTIONAL }
    der::Parser policy_qualifiers_sequence_parser;
    if (!policy_information_parser.ReadSequence(
            &policy_qualifiers_sequence_parser)) {
      return false;
    }
    // Should not have trailing data after policyQualifiers sequence.
    if (policy_information_parser.HasMore()) {
      errors->AddError(kPolicyInformationTrailingData);
      return false;
    }

    // RFC 5280 section 4.2.1.4: When qualifiers are used with the special
    // policy anyPolicy, they MUST be limited to the qualifiers identified in
    // this section.
    if (!ParsePolicyQualifiers(fail_parsing_unknown_qualifier_oids ||
                                   policy_oid == der::Input(kAnyPolicyOid),
                               &policy_qualifiers_sequence_parser,
                               policy_qualifiers, errors)) {
      errors->AddError(kFailedParsingPolicyQualifiers);
      return false;
    }
  }

  // RFC 5280 section 4.2.1.4: A certificate policy OID MUST NOT appear more
  // than once in a certificate policies extension.
  std::sort(policy_oids->begin(), policy_oids->end());
  auto dupe_policy_iter =
      std::adjacent_find(policy_oids->begin(), policy_oids->end());
  if (dupe_policy_iter != policy_oids->end()) {
    errors->AddError(kPoliciesDuplicateOid,
                     CreateCertErrorParams1Der("oid", *dupe_policy_iter));
    return false;
  }

  return true;
}

}  // namespace

PolicyInformation::PolicyInformation() = default;
PolicyInformation::~PolicyInformation() = default;
PolicyInformation::PolicyInformation(const PolicyInformation &) = default;
PolicyInformation::PolicyInformation(PolicyInformation &&) = default;

bool ParseCertificatePoliciesExtension(der::Input extension_value,
                                       std::vector<PolicyInformation> *policies,
                                       CertErrors *errors) {
  std::vector<der::Input> unused_policy_oids;
  return ParseCertificatePoliciesExtensionImpl(
      extension_value, /*fail_parsing_unknown_qualifier_oids=*/false,
      &unused_policy_oids, policies, errors);
}

bool ParseCertificatePoliciesExtensionOids(
    der::Input extension_value, bool fail_parsing_unknown_qualifier_oids,
    std::vector<der::Input> *policy_oids, CertErrors *errors) {
  return ParseCertificatePoliciesExtensionImpl(
      extension_value, fail_parsing_unknown_qualifier_oids, policy_oids,
      nullptr, errors);
}

// From RFC 5280:
//
//   PolicyConstraints ::= SEQUENCE {
//        requireExplicitPolicy           [0] SkipCerts OPTIONAL,
//        inhibitPolicyMapping            [1] SkipCerts OPTIONAL }
//
//   SkipCerts ::= INTEGER (0..MAX)
bool ParsePolicyConstraints(der::Input policy_constraints_tlv,
                            ParsedPolicyConstraints *out) {
  der::Parser parser(policy_constraints_tlv);

  //   PolicyConstraints ::= SEQUENCE {
  der::Parser sequence_parser;
  if (!parser.ReadSequence(&sequence_parser)) {
    return false;
  }

  // RFC 5280 prohibits CAs from issuing PolicyConstraints as an empty sequence:
  //
  //   Conforming CAs MUST NOT issue certificates where policy constraints
  //   is an empty sequence.  That is, either the inhibitPolicyMapping field
  //   or the requireExplicitPolicy field MUST be present.  The behavior of
  //   clients that encounter an empty policy constraints field is not
  //   addressed in this profile.
  if (!sequence_parser.HasMore()) {
    return false;
  }

  std::optional<der::Input> require_value;
  if (!sequence_parser.ReadOptionalTag(CBS_ASN1_CONTEXT_SPECIFIC | 0,
                                       &require_value)) {
    return false;
  }

  if (require_value) {
    uint8_t require_explicit_policy;
    if (!ParseUint8(require_value.value(), &require_explicit_policy)) {
      // TODO(eroman): Surface reason for failure if length was longer than
      // uint8.
      return false;
    }
    out->require_explicit_policy = require_explicit_policy;
  }

  std::optional<der::Input> inhibit_value;
  if (!sequence_parser.ReadOptionalTag(CBS_ASN1_CONTEXT_SPECIFIC | 1,
                                       &inhibit_value)) {
    return false;
  }

  if (inhibit_value) {
    uint8_t inhibit_policy_mapping;
    if (!ParseUint8(inhibit_value.value(), &inhibit_policy_mapping)) {
      // TODO(eroman): Surface reason for failure if length was longer than
      // uint8.
      return false;
    }
    out->inhibit_policy_mapping = inhibit_policy_mapping;
  }

  // There should be no remaining data.
  if (sequence_parser.HasMore() || parser.HasMore()) {
    return false;
  }

  return true;
}

// From RFC 5280:
//
//   InhibitAnyPolicy ::= SkipCerts
//
//   SkipCerts ::= INTEGER (0..MAX)
std::optional<uint8_t> ParseInhibitAnyPolicy(
    der::Input inhibit_any_policy_tlv) {
  der::Parser parser(inhibit_any_policy_tlv);
  std::optional<uint8_t> num_certs = std::make_optional<uint8_t>();

  // TODO(eroman): Surface reason for failure if length was longer than uint8.
  if (!parser.ReadUint8(&num_certs.value())) {
    return std::nullopt;
  }

  // There should be no remaining data.
  if (parser.HasMore()) {
    return std::nullopt;
  }

  return num_certs;
}

// From RFC 5280:
//
//   PolicyMappings ::= SEQUENCE SIZE (1..MAX) OF SEQUENCE {
//        issuerDomainPolicy      CertPolicyId,
//        subjectDomainPolicy     CertPolicyId }
bool ParsePolicyMappings(der::Input policy_mappings_tlv,
                         std::vector<ParsedPolicyMapping> *mappings) {
  mappings->clear();

  der::Parser parser(policy_mappings_tlv);

  //   PolicyMappings ::= SEQUENCE SIZE (1..MAX) OF SEQUENCE {
  der::Parser sequence_parser;
  if (!parser.ReadSequence(&sequence_parser)) {
    return false;
  }

  // Must be at least 1 mapping.
  if (!sequence_parser.HasMore()) {
    return false;
  }

  while (sequence_parser.HasMore()) {
    der::Parser mapping_parser;
    if (!sequence_parser.ReadSequence(&mapping_parser)) {
      return false;
    }

    ParsedPolicyMapping mapping;
    if (!mapping_parser.ReadTag(CBS_ASN1_OBJECT,
                                &mapping.issuer_domain_policy)) {
      return false;
    }
    if (!mapping_parser.ReadTag(CBS_ASN1_OBJECT,
                                &mapping.subject_domain_policy)) {
      return false;
    }

    // There shouldn't be extra unconsumed data.
    if (mapping_parser.HasMore()) {
      return false;
    }

    mappings->push_back(mapping);
  }

  // There shouldn't be extra unconsumed data.
  if (parser.HasMore()) {
    return false;
  }

  return true;
}

BSSL_NAMESPACE_END
