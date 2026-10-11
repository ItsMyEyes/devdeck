package store

import (
	"database/sql"
	"math/rand/v2"
)

var characterFirst = []string{"Arka", "Nara", "Raka", "Dina", "Salsa", "Fajar", "Rani", "Gilang", "Bima", "Ayu", "Tara", "Damar", "Laras", "Bayu", "Nadia", "Reza"}
var characterLast = []string{"Pratama", "Putra", "Wisesa", "Lestari", "Kirana", "Wijaya", "Nugraha", "Utama", "Ananta", "Permata", "Saputra", "Pertiwi", "Santoso", "Mahendra", "Amani", "Cahya"}

func newCharacterName() string {
	return characterFirst[rand.IntN(len(characterFirst))] + " " + characterLast[rand.IntN(len(characterLast))]
}
func backfillCharacterNames(db *sql.DB) error {
	rows, err := db.Query(`SELECT id FROM agent_thread WHERE character_name=''`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, id := range ids {
		if _, err = tx.Exec(`UPDATE agent_thread SET character_name=? WHERE id=? AND character_name=''`, newCharacterName(), id); err != nil {
			return err
		}
	}
	return tx.Commit()
}
