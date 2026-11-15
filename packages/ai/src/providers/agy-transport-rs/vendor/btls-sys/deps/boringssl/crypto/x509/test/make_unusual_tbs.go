// Copyright 2025 The BoringSSL Authors
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

//go:build ignore

// make_unusual_tbs.go refreshes the signatures on the unusual_tbs_*.pem
// certificates.
package main

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	_ "crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"

	"golang.org/x/crypto/cryptobyte"
	"golang.org/x/crypto/cryptobyte/asn1"
)

func digest(hash crypto.Hash, in []byte) []byte {
	h := hash.New()
	h.Write(in)
	return h.Sum(nil)
}

func verifySignature(key crypto.PublicKey, in, sig []byte, opts crypto.SignerOpts) bool {
	switch k := key.(type) {
	case *ecdsa.PublicKey:
		return ecdsa.VerifyASN1(k, digest(opts.HashFunc(), in), sig)
	default:
		panic(fmt.Sprintf("unknown key type %T", k))
	}
}

func updateSignature(path string, key crypto.Signer, opts crypto.SignerOpts) error {
	inp, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	block, _ := pem.Decode(inp)
	if block == nil || block.Type != "CERTIFICATE" {
		return fmt.Errorf("%q did not contain a PEM CERTIFICATE block", path)
	}

	s := cryptobyte.String(block.Bytes)
	var cert, tbsCert, sigAlg cryptobyte.String
	var sig []byte
	if !s.ReadASN1(&cert, asn1.SEQUENCE) ||
		!cert.ReadASN1Element(&tbsCert, asn1.SEQUENCE) ||
		!cert.ReadASN1Element(&sigAlg, asn1.SEQUENCE) ||
		!cert.ReadASN1BitStringAsBytes(&sig) ||
		!cert.Empty() {
		return fmt.Errorf("could not parse certificate in %q", path)
	}

	// Check if the signature is already valid.
	if verifySignature(key.Public(), tbsCert, sig, opts) {
		return nil
	}

	newSig, err := key.Sign(rand.Reader, digest(opts.HashFunc(), tbsCert), opts)
	if err != nil {
		return err
	}

	b := cryptobyte.NewBuilder(nil)
	b.AddASN1(asn1.SEQUENCE, func(child *cryptobyte.Builder) {
		child.AddBytes(tbsCert)
		child.AddBytes(sigAlg)
		child.AddASN1BitString(newSig)
	})
	newCert, err := b.Bytes()
	if err != nil {
		return err
	}

	newPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: newCert})
	return os.WriteFile(path, newPEM, 0644)
}

func loadPEMPrivateKey(path string) (crypto.Signer, error) {
	inp, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(inp)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%q did not contain a PEM PRIVATE KEY block", path)
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	signer, ok := key.(crypto.Signer)
	if !ok {
		return nil, fmt.Errorf("key in %q was not a signing key", path)
	}
	return signer, nil
}

func main() {
	key, err := loadPEMPrivateKey("unusual_tbs_key.pem")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading private key: %s\n", err)
		os.Exit(1)
	}

	paths := []string{
		"unusual_tbs_critical_ber.pem",
		"unusual_tbs_critical_false_not_omitted.pem",
		"unusual_tbs_empty_extension_not_omitted.pem",
		"unusual_tbs_null_sigalg_param.pem",
		"unusual_tbs_uid_both.pem",
		"unusual_tbs_uid_issuer.pem",
		"unusual_tbs_uid_subject.pem",
		"unusual_tbs_wrong_attribute_order.pem",
		"unusual_tbs_v1_not_omitted.pem",
	}
	for _, path := range paths {
		if err := updateSignature(path, key, crypto.SHA256); err != nil {
			fmt.Fprintf(os.Stderr, "Error signing %q: %s\n", path, err)
			os.Exit(1)
		}
	}
}
