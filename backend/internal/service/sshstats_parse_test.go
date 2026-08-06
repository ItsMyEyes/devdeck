package service

import "testing"

const sampleProcStat = `cpu  100 20 30 800 40 0 10 0 0 0
cpu0 50 10 15 400 20 0 5 0 0 0
intr 12345
ctxt 67890
`

const sampleMeminfo = `MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    8000000 kB
Buffers:          200000 kB
Cached:          4000000 kB
SwapTotal:       2048000 kB
`

const sampleMeminfoNoAvailable = `MemTotal:       16384000 kB
MemFree:         1000000 kB
Buffers:          200000 kB
Cached:          4000000 kB
`

const sampleDF = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        102400000  41000000  61400000      41% /
`

func TestParseProcStat(t *testing.T) {
	got, err := parseProcStat(sampleProcStat)
	if err != nil {
		t.Fatalf("parseProcStat: %v", err)
	}
	// 100+20+30+800+40+0+10+0+0+0 = 1000
	if got.total != 1000 {
		t.Errorf("total = %d, want 1000", got.total)
	}
	// idle(800) + iowait(40) = 840
	if got.idle != 840 {
		t.Errorf("idle = %d, want 840", got.idle)
	}
}

func TestParseProcStatRejectsGarbage(t *testing.T) {
	for name, input := range map[string]string{
		"empty":        "",
		"no cpu line":  "intr 1\nctxt 2\n",
		"too few cols": "cpu 1 2\n",
		"non-numeric":  "cpu a b c d e f g h\n",
	} {
		if _, err := parseProcStat(input); err == nil {
			t.Errorf("%s: expected an error, got nil", name)
		}
	}
}

func TestCPUPercent(t *testing.T) {
	tests := []struct {
		name      string
		prev, cur cpuSample
		wantNil   bool
		want      float64
	}{
		{
			name: "half busy",
			prev: cpuSample{total: 1000, idle: 800},
			cur:  cpuSample{total: 2000, idle: 1300},
			// totalDelta 1000, idleDelta 500 => 50%
			want: 50,
		},
		{
			name: "fully idle",
			prev: cpuSample{total: 1000, idle: 800},
			cur:  cpuSample{total: 2000, idle: 1800},
			want: 0,
		},
		{
			name: "fully busy",
			prev: cpuSample{total: 1000, idle: 800},
			cur:  cpuSample{total: 2000, idle: 800},
			want: 100,
		},
		{
			name:    "no elapsed time",
			prev:    cpuSample{total: 1000, idle: 800},
			cur:     cpuSample{total: 1000, idle: 800},
			wantNil: true,
		},
		{
			name:    "counter went backwards (reboot)",
			prev:    cpuSample{total: 5000, idle: 4000},
			cur:     cpuSample{total: 1000, idle: 800},
			wantNil: true,
		},
		{
			name:    "idle outran total",
			prev:    cpuSample{total: 1000, idle: 800},
			cur:     cpuSample{total: 1100, idle: 1000},
			wantNil: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := cpuPercent(tc.prev, tc.cur)
			if tc.wantNil {
				if got != nil {
					t.Fatalf("got %f, want nil", *got)
				}
				return
			}
			if got == nil {
				t.Fatal("got nil, want a value")
			}
			if *got != tc.want {
				t.Errorf("got %f, want %f", *got, tc.want)
			}
		})
	}
}

func TestParseMeminfoPrefersMemAvailable(t *testing.T) {
	got, err := parseMeminfo(sampleMeminfo)
	if err != nil {
		t.Fatalf("parseMeminfo: %v", err)
	}
	const kb = 1024
	if got.Total != 16384000*kb {
		t.Errorf("Total = %d, want %d", got.Total, uint64(16384000*kb))
	}
	// used = MemTotal - MemAvailable = 16384000 - 8000000 = 8384000 kB
	if got.Used != 8384000*kb {
		t.Errorf("Used = %d, want %d", got.Used, uint64(8384000*kb))
	}
}

func TestParseMeminfoFallsBackWithoutMemAvailable(t *testing.T) {
	got, err := parseMeminfo(sampleMeminfoNoAvailable)
	if err != nil {
		t.Fatalf("parseMeminfo: %v", err)
	}
	const kb = 1024
	// used = Total - Free - Buffers - Cached
	//      = 16384000 - 1000000 - 200000 - 4000000 = 11184000 kB
	if got.Used != 11184000*kb {
		t.Errorf("Used = %d, want %d", got.Used, uint64(11184000*kb))
	}
}

func TestParseMeminfoRejectsMissingTotal(t *testing.T) {
	if _, err := parseMeminfo("MemFree: 100 kB\n"); err == nil {
		t.Fatal("expected an error when MemTotal is absent")
	}
}

func TestParseDF(t *testing.T) {
	got, err := parseDF(sampleDF)
	if err != nil {
		t.Fatalf("parseDF: %v", err)
	}
	const block = 1024
	if got.Total != 102400000*block {
		t.Errorf("Total = %d, want %d", got.Total, uint64(102400000*block))
	}
	if got.Used != 41000000*block {
		t.Errorf("Used = %d, want %d", got.Used, uint64(41000000*block))
	}
}

func TestParseDFRejectsHeaderOnly(t *testing.T) {
	if _, err := parseDF("Filesystem 1024-blocks Used Available Capacity Mounted on\n"); err == nil {
		t.Fatal("expected an error when df has no data row")
	}
}

func TestSplitStatsOutput(t *testing.T) {
	out := sampleProcStat + "---\n" + sampleMeminfo + "---\n" + sampleDF
	stat, meminfo, df, err := splitStatsOutput(out)
	if err != nil {
		t.Fatalf("splitStatsOutput: %v", err)
	}
	if stat == "" || meminfo == "" || df == "" {
		t.Fatalf("empty section: stat=%d meminfo=%d df=%d", len(stat), len(meminfo), len(df))
	}
	if _, err := parseProcStat(stat); err != nil {
		t.Errorf("stat section does not parse: %v", err)
	}
}

func TestSplitStatsOutputRejectsWrongSectionCount(t *testing.T) {
	if _, _, _, err := splitStatsOutput("only one section\n"); err == nil {
		t.Fatal("expected an error for a single-section output")
	}
}
