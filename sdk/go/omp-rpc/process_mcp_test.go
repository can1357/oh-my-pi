//go:build unix

package omprpc

import (
	"io"
	"os/exec"
	"testing"
)

// A host with MCP off (PI_NO_MCP=1) starts a server that has MCP off, whatever
// the command's own Env says.
func TestStartKeepsMCPOffForAHostWithMCPOff(t *testing.T) {
	for _, override := range []string{"", "0", "false"} {
		t.Run("override="+override, func(t *testing.T) {
			t.Setenv("PI_NO_MCP", "1")
			cmd := exec.Command("sh", "-c", `printf '<%s>' "$PI_NO_MCP"`)
			cmd.Env = []string{"PATH=/usr/bin:/bin", "PI_NO_MCP=" + override}
			proc, stdin, err := startProcess(cmd)
			if err != nil {
				t.Fatal(err)
			}
			defer stdin.Close()
			out, err := io.ReadAll(proc.stdout)
			if err != nil {
				t.Fatal(err)
			}
			<-proc.exited
			if got := string(out); got != "<1>" {
				t.Fatalf("server saw PI_NO_MCP=%s, want <1>", got)
			}
		})
	}
}

func TestStartPassesTheOverrideForAHostWithMCPOn(t *testing.T) {
	t.Setenv("PI_NO_MCP", "")
	cmd := exec.Command("sh", "-c", `printf '<%s>' "$PI_NO_MCP"`)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "PI_NO_MCP=1"}
	proc, stdin, err := startProcess(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	out, _ := io.ReadAll(proc.stdout)
	<-proc.exited
	if got := string(out); got != "<1>" {
		t.Fatalf("server saw PI_NO_MCP=%s, want <1>", got)
	}
}
