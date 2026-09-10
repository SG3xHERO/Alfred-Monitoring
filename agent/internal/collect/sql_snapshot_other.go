//go:build !windows

package collect

import (
	"errors"
	"time"
)

// CaptureSqlSnapshot is Windows-only (SQL Server diagnostics via Integrated
// Security). Stubbed here so the shared main.go still compiles on Linux.
func CaptureSqlSnapshot(timeout time.Duration) (*SqlSnapshot, error) {
	return nil, errors.New("sql snapshot not supported on this platform")
}
