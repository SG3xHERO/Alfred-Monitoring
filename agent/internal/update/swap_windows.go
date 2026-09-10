//go:build windows

package update

import "os"

// Windows allows renaming an in-use executable (just not overwriting its
// bytes in place while a handle is open), so: rename the running exe aside,
// move the new one into its place, then the caller exits. The Windows
// Service Control Manager's configured restart-on-exit recovery action
// (sc.exe failure alfred-agent reset= 0 actions= restart/5000, set during
// install — see deploy/install-agent-windows.ps1) relaunches the service,
// now pointing at the swapped-in binary.
func swapIntoPlace(exePath, newPath string) error {
	oldPath := exePath + ".old"
	os.Remove(oldPath) // best-effort; a stale .old from a prior run shouldn't block this one
	if err := os.Rename(exePath, oldPath); err != nil {
		return err
	}
	if err := os.Rename(newPath, exePath); err != nil {
		_ = os.Rename(oldPath, exePath) // restore so the service isn't left with no binary
		return err
	}
	return nil
}
