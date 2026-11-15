package subprocess

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// Common top-level structure to parse mode
type mlkemTestVectorSet struct {
	Algorithm string `json:"algorithm"`
	Mode      string `json:"mode"`
	Revision  string `json:"revision"`
}

// Key generation specific structures
type mlkemKeyGenTestVectorSet struct {
	Algorithm string                 `json:"algorithm"`
	Mode      string                 `json:"mode"`
	Revision  string                 `json:"revision"`
	Groups    []mlkemKeyGenTestGroup `json:"testGroups"`
}

type mlkemKeyGenTestGroup struct {
	ID           uint64            `json:"tgId"`
	TestType     string            `json:"testType"`
	ParameterSet string            `json:"parameterSet"`
	Tests        []mlkemKeyGenTest `json:"tests"`
}

type mlkemKeyGenTest struct {
	ID uint64 `json:"tcId"`
	Z  string `json:"z"`
	D  string `json:"d"`
}

type mlkemKeyGenTestGroupResponse struct {
	ID    uint64                    `json:"tgId"`
	Tests []mlkemKeyGenTestResponse `json:"tests"`
}

type mlkemKeyGenTestResponse struct {
	ID uint64 `json:"tcId"`
	EK string `json:"ek"`
	DK string `json:"dk"`
}

type mlkemEncapDecapTestVectorSet struct {
	Algorithm string                     `json:"algorithm"`
	Mode      string                     `json:"mode"`
	Revision  string                     `json:"revision"`
	Groups    []mlkemEncapDecapTestGroup `json:"testGroups"`
}

type mlkemEncapDecapTestGroup struct {
	ID           uint64                `json:"tgId"`
	TestType     string                `json:"testType"`
	ParameterSet string                `json:"parameterSet"`
	Function     string                `json:"function"`
	DK           string                `json:"dk,omitempty"`
	Tests        []mlkemEncapDecapTest `json:"tests"`
}

type mlkemEncapDecapTest struct {
	ID uint64 `json:"tcId"`
	EK string `json:"ek,omitempty"`
	M  string `json:"m,omitempty"`
	C  string `json:"c,omitempty"`
}

type mlkemEncapDecapTestGroupResponse struct {
	ID    uint64                        `json:"tgId"`
	Tests []mlkemEncapDecapTestResponse `json:"tests"`
}

type mlkemEncapDecapTestResponse struct {
	ID uint64 `json:"tcId"`
	C  string `json:"c,omitempty"`
	K  string `json:"k,omitempty"`
}

type mlkem struct{}

func (m *mlkem) Process(vectorSet []byte, t Transactable) (any, error) {
	var common mlkemTestVectorSet
	if err := json.Unmarshal(vectorSet, &common); err != nil {
		return nil, fmt.Errorf("failed to unmarshal vector set: %v", err)
	}

	switch common.Mode {
	case "keyGen":
		return m.processKeyGen(vectorSet, t)
	case "encapDecap":
		return m.processEncapDecap(vectorSet, t)
	default:
		return nil, fmt.Errorf("unsupported ML-KEM mode: %q", common.Mode)
	}
}

func (m *mlkem) processKeyGen(vectorSet []byte, t Transactable) (any, error) {
	var parsed mlkemKeyGenTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, fmt.Errorf("failed to unmarshal keyGen vector set: %v", err)
	}

	var ret []mlkemKeyGenTestGroupResponse

	for _, group := range parsed.Groups {
		response := mlkemKeyGenTestGroupResponse{
			ID: group.ID,
		}

		if !strings.HasPrefix(group.ParameterSet, "ML-KEM-") {
			return nil, fmt.Errorf("invalid parameter set: %s", group.ParameterSet)
		}
		cmdName := group.ParameterSet + "/keyGen"

		for _, test := range group.Tests {
			// Concatenate d and z to form the seed
			dBytes, err := hex.DecodeString(test.D)
			if err != nil {
				return nil, fmt.Errorf("failed to decode d in test case %d/%d: %s",
					group.ID, test.ID, err)
			}
			zBytes, err := hex.DecodeString(test.Z)
			if err != nil {
				return nil, fmt.Errorf("failed to decode z in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			seed := make([]byte, len(dBytes)+len(zBytes))
			copy(seed, dBytes)
			copy(seed[len(dBytes):], zBytes)

			result, err := t.Transact(cmdName, 2, seed)
			if err != nil {
				return nil, fmt.Errorf("key generation failed for test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			response.Tests = append(response.Tests, mlkemKeyGenTestResponse{
				ID: test.ID,
				EK: hex.EncodeToString(result[0]),
				DK: hex.EncodeToString(result[1]),
			})
		}

		ret = append(ret, response)
	}

	return ret, nil
}

func (m *mlkem) processEncapDecap(vectorSet []byte, t Transactable) (any, error) {
	var parsed mlkemEncapDecapTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, fmt.Errorf("failed to unmarshal encapDecap vector set: %v", err)
	}

	var ret []mlkemEncapDecapTestGroupResponse

	for _, group := range parsed.Groups {
		response := mlkemEncapDecapTestGroupResponse{
			ID: group.ID,
		}

		if !strings.HasPrefix(group.ParameterSet, "ML-KEM-") {
			return nil, fmt.Errorf("invalid parameter set: %s", group.ParameterSet)
		}

		switch group.Function {
		case "encapsulation":
			cmdName := group.ParameterSet + "/encap"
			for _, test := range group.Tests {
				ek, err := hex.DecodeString(test.EK)
				if err != nil {
					return nil, fmt.Errorf("failed to decode ek in test case %d/%d: %s",
						group.ID, test.ID, err)
				}

				m, err := hex.DecodeString(test.M)
				if err != nil {
					return nil, fmt.Errorf("failed to decode m in test case %d/%d: %s",
						group.ID, test.ID, err)
				}

				result, err := t.Transact(cmdName, 2, ek, m)
				if err != nil {
					return nil, fmt.Errorf("encapsulation failed for test case %d/%d: %s",
						group.ID, test.ID, err)
				}

				response.Tests = append(response.Tests, mlkemEncapDecapTestResponse{
					ID: test.ID,
					C:  hex.EncodeToString(result[0]),
					K:  hex.EncodeToString(result[1]),
				})
			}

		case "decapsulation":
			cmdName := group.ParameterSet + "/decap"
			dk, err := hex.DecodeString(group.DK)
			if err != nil {
				return nil, fmt.Errorf("failed to decode dk in group %d: %s",
					group.ID, err)
			}

			for _, test := range group.Tests {
				c, err := hex.DecodeString(test.C)
				if err != nil {
					return nil, fmt.Errorf("failed to decode c in test case %d/%d: %s",
						group.ID, test.ID, err)
				}

				result, err := t.Transact(cmdName, 1, dk, c)
				if err != nil {
					return nil, fmt.Errorf("decapsulation failed for test case %d/%d: %s",
						group.ID, test.ID, err)
				}

				response.Tests = append(response.Tests, mlkemEncapDecapTestResponse{
					ID: test.ID,
					K:  hex.EncodeToString(result[0]),
				})
			}

		default:
			return nil, fmt.Errorf("unsupported function: %s", group.Function)
		}

		ret = append(ret, response)
	}

	return ret, nil
}
