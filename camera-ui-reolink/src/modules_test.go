package main

import (
	"runtime/debug"
	"strings"
	"testing"
)

// The plugin built against github.com/cameraui/sdk/go and github.com/cameraui/rpc/go downloaded from the Go module
// proxy, the camera.ui author's. Both come from VION's copy now (externals/sdk-go, externals/rpc-go: v1.3.5 and
// v1.0.19, the same bytes), through replace in go.mod: the import paths stay, nothing of his is downloaded.
func TestTheAuthorsModulesComeFromOurCopy(t *testing.T) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		t.Fatal("no build info in the test binary")
	}
	want := map[string]string{
		"github.com/cameraui/sdk/go": "../externals/sdk-go",
		"github.com/cameraui/rpc/go": "../externals/rpc-go",
	}
	seen := map[string]bool{}
	for _, dep := range info.Deps {
		if !strings.HasPrefix(dep.Path, "github.com/cameraui/") {
			continue
		}
		folder, ours := want[dep.Path]
		if !ours {
			t.Errorf("%s %s: a module of the author without a copy of ours", dep.Path, dep.Version)
			continue
		}
		if dep.Replace == nil || dep.Replace.Path != folder {
			t.Errorf("%s %s: built from the module proxy, not from %s", dep.Path, dep.Version, folder)
		}
		seen[dep.Path] = true
	}
	for path := range want {
		if !seen[path] {
			t.Errorf("%s: not among the modules of the build", path)
		}
	}
}
