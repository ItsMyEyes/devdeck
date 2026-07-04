package selfupdate

import "testing"

func TestNeedsUpdate(t *testing.T) {
	tests := []struct {
		name    string
		current string
		latest  string
		want    bool
		wantErr bool
	}{
		{name: "newer available", current: "v1.0.0", latest: "v1.1.0", want: true},
		{name: "already latest", current: "v1.0.0", latest: "v1.0.0", want: false},
		{name: "current newer than latest", current: "v1.1.0", latest: "v1.0.0", want: false},
		{name: "missing v prefix on both sides", current: "1.0.0", latest: "1.1.0", want: true},
		{name: "dev build refuses", current: "dev", latest: "v1.0.0", wantErr: true},
		{name: "invalid latest tag", current: "v1.0.0", latest: "not-a-version", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NeedsUpdate(tt.current, tt.latest)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("NeedsUpdate(%q, %q) error = nil, want non-nil", tt.current, tt.latest)
				}
				return
			}
			if err != nil {
				t.Fatalf("NeedsUpdate(%q, %q) unexpected error: %v", tt.current, tt.latest, err)
			}
			if got != tt.want {
				t.Errorf("NeedsUpdate(%q, %q) = %v, want %v", tt.current, tt.latest, got, tt.want)
			}
		})
	}
}
