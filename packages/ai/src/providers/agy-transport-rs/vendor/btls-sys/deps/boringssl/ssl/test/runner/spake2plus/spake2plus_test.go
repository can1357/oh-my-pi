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

package spake2plus

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"testing"
)

func hexToBytes(h string) []byte {
	b, err := hex.DecodeString(h)
	if err != nil {
		panic(err)
	}
	return b
}

func TestSPAKE2PlusBasicRoundTrip(t *testing.T) {
	pw := []byte("password")
	context := []byte("SPAKE2+-P256-SHA256-HKDF-SHA256-HMAC-SHA256 Test Vectors")
	idProver := []byte("client")
	idVerifier := []byte("server")

	pwVerifierW0, pwVerifierW1, registrationRecord, err := Register(
		pw, idProver, idVerifier,
	)
	if err != nil {
		t.Fatalf("Registration failed: %v", err)
	}

	prover, err := NewProver(
		context, idProver, idVerifier,
		pwVerifierW0, pwVerifierW1,
	)
	if err != nil {
		t.Fatalf("Prover context creation failed: %v", err)
	}
	verifier, err := NewVerifier(
		context, idProver, idVerifier,
		pwVerifierW0, registrationRecord,
	)
	if err != nil {
		t.Fatalf("Verifier context creation failed: %v", err)
	}

	proverShare, err := prover.GenerateProverShare()
	if err != nil {
		t.Fatalf("Prover share generation failed: %v", err)
	}

	verifierShare, verifierConfirm, verifierSecret, err := verifier.ProcessProverShare(proverShare)
	if err != nil {
		t.Fatalf("Verifier failed to process prover's share: %v", err)
	}

	proverConfirm, proverSecret, err := prover.ComputeProverConfirmation(verifierShare, verifierConfirm)
	if err != nil {
		t.Fatalf("Prover failed to compute confirmation: %v", err)
	}

	if err := verifier.VerifyProverConfirmation(proverConfirm); err != nil {
		t.Fatalf("Verifier failed to verify prover confirmation: %v", err)
	}

	if !bytes.Equal(proverSecret, verifierSecret) {
		t.Fatal("Shared secrets do not match")
	}
}

func TestSPAKE2PlusTestVectors(t *testing.T) {
	// Test Vectors from RFC 9383 Appendix C
	context := []byte("SPAKE2+-P256-SHA256-HKDF-SHA256-HMAC-SHA256 Test Vectors")
	idProver := []byte("client")
	idVerifier := []byte("server")

	w0_str := "bb8e1bbcf3c48f62c08db243652ae55d3e5586053fca77102994f23ad95491b3"
	w1_str := "7e945f34d78785b8a3ef44d0df5a1a97d6b3b460409a345ca7830387a74b1dba"
	L_str := "04eb7c9db3d9a9eb1f8adab81b5794c1f13ae3e225efbe91ea487425854c7fc00f00bfedcbd09b2400142d40a14f2064ef31dfaa903b91d1faea7093d835966efd"
	x_str := "d1232c8e8693d02368976c174e2088851b8365d0d79a9eee709c6a05a2fad539"
	y_str := "717a72348a182085109c8d3917d6c43d59b224dc6a7fc4f0483232fa6516d8b3"
	share_p_str := "04ef3bd051bf78a2234ec0df197f7828060fe9856503579bb1733009042c15c0c1de127727f418b5966afadfdd95a6e4591d171056b333dab97a79c7193e341727"
	share_v_str := "04c0f65da0d11927bdf5d560c69e1d7d939a05b0e88291887d679fcadea75810fb5cc1ca7494db39e82ff2f50665255d76173e09986ab46742c798a9a68437b048"
	confirm_p_str := "926cc713504b9b4d76c9162ded04b5493e89109f6d89462cd33adc46fda27527"
	confirm_v_str := "9747bcc4f8fe9f63defee53ac9b07876d907d55047e6ff2def2e7529089d3e68"
	secret_str := "0c5f8ccd1413423a54f6c1fb26ff01534a87f893779c6e68666d772bfd91f3e7"

	w0 := hexToBytes(w0_str)
	w1 := hexToBytes(w1_str)
	L := hexToBytes(L_str)
	x := hexToBytes(x_str)
	y := hexToBytes(y_str)

	prover, err := newContext(
		RoleProver, context, idProver, idVerifier,
		w0, w1, nil, bytesToBigInt(x), nil,
	)
	if err != nil {
		t.Fatalf("failed to create prover: %v", err)
	}
	verifier, err := newContext(
		RoleVerifier, context, idProver, idVerifier,
		w0, nil, L, nil, bytesToBigInt(y),
	)
	if err != nil {
		t.Fatalf("failed to create verifier: %v", err)
	}

	proverShare, err := prover.GenerateProverShare()
	if err != nil {
		t.Fatalf("failed to generate prover share: %v", err)
	}
	expectedShareP := hexToBytes(share_p_str)
	if !bytes.Equal(proverShare, expectedShareP) {
		t.Fatalf("prover share mismatch:\n got  %x\nwant %x", proverShare, expectedShareP)
	}

	vShare, vConfirm, vSecret, err := verifier.ProcessProverShare(proverShare)
	if err != nil {
		t.Fatalf("verifier failed to process prover share: %v", err)
	}
	expectedShareV := hexToBytes(share_v_str)
	if !bytes.Equal(vShare, expectedShareV) {
		t.Fatalf("verifier share mismatch:\n got  %x\nwant %x", vShare, expectedShareV)
	}
	expectedConfirmV := hexToBytes(confirm_v_str)
	if !bytes.Equal(vConfirm, expectedConfirmV) {
		t.Fatalf("verifier confirm mismatch:\n got  %x\nwant %x", vConfirm, expectedConfirmV)
	}

	pConfirm, pSecret, err := prover.ComputeProverConfirmation(vShare, vConfirm)
	if err != nil {
		t.Fatalf("prover failed to compute confirmation: %v", err)
	}
	expectedConfirmP := hexToBytes(confirm_p_str)
	if !bytes.Equal(pConfirm, expectedConfirmP) {
		t.Fatalf("prover confirm mismatch:\n got  %x\nwant %x", pConfirm, expectedConfirmP)
	}

	if err := verifier.VerifyProverConfirmation(pConfirm); err != nil {
		t.Fatalf("verifier failed to verify prover confirmation: %v", err)
	}

	if !bytes.Equal(pSecret, vSecret) {
		t.Fatal("shared secrets do not match")
	}
	expectedSecret := hexToBytes(secret_str)
	if !bytes.Equal(expectedSecret, vSecret) {
		t.Fatalf("shared secret mismatch:\n got  %x\nwant %x", vSecret, expectedSecret)
	}
}

func TestSPAKE2PlusMultipleRuns(t *testing.T) {
	pw := []byte("password")
	context := []byte("Repeated test")
	idProver := []byte("client")
	idVerifier := []byte("server")

	for i := 0; i < 5; i++ {
		pwVerifierW0, pwVerifierW1, registrationRecord, err := Register(
			pw, idProver, idVerifier)
		if err != nil {
			t.Fatalf("registration failed: %v", err)
		}
		prover, err := NewProver(context, idProver, idVerifier, pwVerifierW0, pwVerifierW1)
		if err != nil {
			t.Fatalf("prover context creation failed: %v", err)
		}
		verifier, err := NewVerifier(context, idProver, idVerifier, pwVerifierW0, registrationRecord)
		if err != nil {
			t.Fatalf("verifier context creation failed: %v", err)
		}

		proverShare, err := prover.GenerateProverShare()
		if err != nil {
			t.Fatalf("prover share gen failed: %v", err)
		}

		vShare, vConfirm, vSecret, err := verifier.ProcessProverShare(proverShare)
		if err != nil {
			t.Fatalf("verifier process share failed: %v", err)
		}

		pConfirm, pSecret, err := prover.ComputeProverConfirmation(vShare, vConfirm)
		if err != nil {
			t.Fatalf("prover compute confirm failed: %v", err)
		}

		if err := verifier.VerifyProverConfirmation(pConfirm); err != nil {
			t.Fatalf("verifier confirm failed: %v", err)
		}

		if !bytes.Equal(pSecret, vSecret) {
			t.Fatalf("shared secrets differ")
		}
	}
}

func TestSPAKE2PlusWrongPassword(t *testing.T) {
	correctPw := []byte("password")
	wrongPw := []byte("wrongpassword")
	context := []byte("Wrong password test")
	idProver := []byte("client")
	idVerifier := []byte("server")

	// Register with the correct password
	correctW0, _, registrationRecord, err := Register(
		correctPw, idProver, idVerifier)
	if err != nil {
		t.Fatalf("registration failed: %v", err)
	}

	// Register with the wrong password
	wrongW0, wrongW1, _, err := Register(
		wrongPw, idProver, idVerifier)
	if err != nil {
		t.Fatalf("registration failed: %v", err)
	}

	// Create prover with wrong password verifiers
	prover, err := NewProver(context, idProver, idVerifier, wrongW0, wrongW1)
	if err != nil {
		t.Fatalf("prover context creation failed: %v", err)
	}

	// Create verifier with correct password verifiers
	verifier, err := NewVerifier(context, idProver, idVerifier, correctW0, registrationRecord)
	if err != nil {
		t.Fatalf("verifier context creation failed: %v", err)
	}

	proverShare, err := prover.GenerateProverShare()
	if err != nil {
		t.Fatalf("prover share gen failed: %v", err)
	}

	vShare, vConfirm, _, err := verifier.ProcessProverShare(proverShare)
	if err != nil {
		t.Fatalf("verifier process share failed: %v", err)
	}

	_, _, err = prover.ComputeProverConfirmation(vShare, vConfirm)
	if err == nil {
		t.Fatalf("expected error computing confirmation, got nil")
	}
}

func bytesToBigInt(b []byte) *big.Int {
	if len(b) == 0 {
		return nil
	}
	return new(big.Int).SetBytes(b)
}
