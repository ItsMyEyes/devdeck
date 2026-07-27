package store

import (
	"errors"
	"testing"

	"devdeck/backend/internal/port"
)

func TestCreateBookmarkPersistsAndLists(t *testing.T) {
	s := newTestStore(t)
	b, err := s.CreateBookmark("m-1", "Docs", "Example", "https://example.com/", "data:image/png;base64,abc")
	if err != nil {
		t.Fatal(err)
	}
	if b.ID == "" || b.ID[:3] != "bm-" {
		t.Errorf("ID = %q, want bm- prefix", b.ID)
	}
	list, err := s.Bookmarks()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].MachineID != "m-1" || list[0].Group != "Docs" || list[0].URL != "https://example.com/" {
		t.Errorf("Bookmarks() = %+v", list)
	}
}

func TestCreateBookmarkDefaultsBlankGroup(t *testing.T) {
	s := newTestStore(t)
	b, err := s.CreateBookmark("m-1", "", "Example", "https://example.com/", "")
	if err != nil {
		t.Fatal(err)
	}
	if b.Group != "Portal" {
		t.Errorf("Group = %q, want default %q", b.Group, "Portal")
	}
}

func TestCreateBookmarkSameMachineAndURLUpdatesInPlace(t *testing.T) {
	s := newTestStore(t)
	first, err := s.CreateBookmark("m-1", "Docs", "Example", "https://example.com/", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateBookmark("m-1", "Reading", "Example Updated", "https://example.com/", "data:image/png;base64,zzz")
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID {
		t.Errorf("re-saving the same machine+url created a new row: %q != %q", second.ID, first.ID)
	}
	list, err := s.Bookmarks()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Errorf("Bookmarks() len = %d, want 1 (upsert, not duplicate)", len(list))
	}
	if list[0].Group != "Reading" || list[0].Title != "Example Updated" || list[0].IconDataURL != "data:image/png;base64,zzz" {
		t.Errorf("Bookmarks()[0] = %+v, want updated fields", list[0])
	}
}

func TestCreateBookmarkSameURLDifferentMachineIsSeparate(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateBookmark("m-1", "Docs", "Example", "https://example.com/", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateBookmark("m-2", "Docs", "Example", "https://example.com/", ""); err != nil {
		t.Fatal(err)
	}
	list, err := s.Bookmarks()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Errorf("Bookmarks() len = %d, want 2 (distinct machines keep separate bookmarks)", len(list))
	}
}

func TestUpdateBookmarkAppliesPartialPatch(t *testing.T) {
	s := newTestStore(t)
	b, _ := s.CreateBookmark("m-1", "Docs", "Example", "https://example.com/", "")
	newTitle := "Renamed"
	got, err := s.UpdateBookmark(b.ID, port.BookmarkPatch{Title: &newTitle})
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Renamed" || got.Group != "Docs" || got.URL != "https://example.com/" {
		t.Errorf("UpdateBookmark = %+v, want only Title changed", got)
	}
}

func TestDeleteBookmarkRemovesIt(t *testing.T) {
	s := newTestStore(t)
	b, _ := s.CreateBookmark("m-1", "Docs", "Example", "https://example.com/", "")
	if err := s.DeleteBookmark(b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BookmarkByID(b.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("BookmarkByID after delete = %v, want ErrNotFound", err)
	}
}

func TestBookmarkByIDMissingReturnsNotFound(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.BookmarkByID("bm-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestDeleteBookmarkMissingReturnsNotFound(t *testing.T) {
	s := newTestStore(t)
	if err := s.DeleteBookmark("bm-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}
