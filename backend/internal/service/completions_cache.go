package service

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"devdeck/backend/internal/completions/provider"
)

const (
	cacheMaxEntries = 300
	cacheTTL        = 5 * time.Minute
)

type cacheEntry struct {
	key       string
	value     string
	expiresAt time.Time
}

// boundedCache is a FIFO-eviction, TTL-expiring cache, not true LRU —
// recency tracking isn't worth the complexity for a single-operator,
// ~300-entry completions cache.
type boundedCache struct {
	mu      sync.Mutex
	order   *list.List
	entries map[string]*list.Element
}

func newBoundedCache() *boundedCache {
	return &boundedCache{order: list.New(), entries: make(map[string]*list.Element)}
}

func (c *boundedCache) get(key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.entries[key]
	if !ok {
		return "", false
	}
	entry := el.Value.(*cacheEntry)
	if time.Now().After(entry.expiresAt) {
		c.order.Remove(el)
		delete(c.entries, key)
		return "", false
	}
	return entry.value, true
}

func (c *boundedCache) set(key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.entries[key]; ok {
		c.order.Remove(el)
		delete(c.entries, key)
	}
	el := c.order.PushBack(&cacheEntry{key: key, value: value, expiresAt: time.Now().Add(cacheTTL)})
	c.entries[key] = el
	for c.order.Len() > cacheMaxEntries {
		oldest := c.order.Front()
		c.order.Remove(oldest)
		delete(c.entries, oldest.Value.(*cacheEntry).key)
	}
}

func cacheKey(prov, model string, req provider.CompletionRequest) string {
	h := sha256.New()
	_ = json.NewEncoder(h).Encode(struct {
		Provider string
		Model    string
		Req      provider.CompletionRequest
	}{prov, model, req})
	return hex.EncodeToString(h.Sum(nil))
}
