package service

import "testing"

func TestBoundedCacheGetSetAndEviction(t *testing.T) {
	c := newBoundedCache()

	if _, ok := c.get("missing"); ok {
		t.Fatal("get on empty cache returned ok=true")
	}

	c.set("a", "value-a")
	got, ok := c.get("a")
	if !ok || got != "value-a" {
		t.Fatalf("get(a) = (%q, %v), want (value-a, true)", got, ok)
	}
}

func TestBoundedCacheEvictsOldestBeyondMaxEntries(t *testing.T) {
	c := newBoundedCache()
	for i := 0; i < cacheMaxEntries+10; i++ {
		c.set(string(rune('a'+i%26))+string(rune(i)), "v")
	}
	if len(c.entries) > cacheMaxEntries {
		t.Errorf("cache holds %d entries, want <= %d", len(c.entries), cacheMaxEntries)
	}
}
