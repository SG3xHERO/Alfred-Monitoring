//go:build !windows

package update

import "os"

// Linux allows replacing a running executable's path directly — the process
// keeps executing the old (now unlinked) inode until it exits. systemd's
// Restart=always (see deploy/install-agent-linux.sh) relaunches the service
// after the caller exits, picking up the new binary at exePath.
func swapIntoPlace(exePath, newPath string) error {
	if err := os.Chmod(newPath, 0o755); err != nil {
		return err
	}
	return os.Rename(newPath, exePath)
}
