package store

import (
	"encoding/json"

	"loom/backend/internal/domain"
)

// Seed wipes all tables and inserts the demo dataset.
func (s *Store) Seed() ([]domain.Workspace, error) {
	for _, t := range []string{"worktrees", "projects", "news", "todos", "invoices", "companies", "banks", "workspaces"} {
		if _, err := s.db.Exec("DELETE FROM " + t); err != nil {
			return nil, err
		}
	}

	for _, c := range seedCompanies() {
		if _, err := s.db.Exec(`INSERT INTO companies (id, name, short_address) VALUES (?, ?, ?)`,
			idGen("co-"), c.Name, c.ShortAddress); err != nil {
			return nil, err
		}
	}
	for _, b := range seedBanks() {
		if _, err := s.db.Exec(`INSERT INTO banks (id, bank_name, account_name, account_number) VALUES (?, ?, ?, ?)`,
			idGen("bk-"), b.BankName, b.AccountName, b.AccountNumber); err != nil {
			return nil, err
		}
	}

	data := seedWorkspaces()
	var firstWsID string

	for i, ws := range data {
		wsID := idGen("ws-")
		if i == 0 {
			firstWsID = wsID
		}
		if _, err := s.db.Exec(`INSERT INTO workspaces (id, name) VALUES (?, ?)`, wsID, ws.Name); err != nil {
			return nil, err
		}

		for _, p := range ws.Projects {
			pID := idGen("p-")
			if _, err := s.db.Exec(`INSERT INTO projects (id, workspace_id, name, repo, path, expanded) VALUES (?, ?, ?, ?, ?, ?)`,
				pID, wsID, p.Name, p.Repo, p.Path, boolInt(p.Expanded)); err != nil {
				return nil, err
			}
			for _, wt := range p.Worktrees {
				wt.ID = idGen("w-")
				if _, err := s.insertWorktree(wt, pID); err != nil {
					return nil, err
				}
			}
		}

		for _, n := range ws.News {
			if _, err := s.db.Exec(`INSERT INTO news (id, workspace_id, source, title, tag, time, unread) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				idGen("n-"), wsID, n.Source, n.Title, n.Tag, n.Time, boolInt(n.Unread)); err != nil {
				return nil, err
			}
		}

		for j := len(ws.Todos) - 1; j >= 0; j-- {
			t := ws.Todos[j]
			if _, err := s.db.Exec(`INSERT INTO todos (id, workspace_id, text, done, priority) VALUES (?, ?, ?, ?, ?)`,
				idGen("t-"), wsID, t.Text, boolInt(t.Done), t.Priority); err != nil {
				return nil, err
			}
		}

		for j := len(ws.Invoices) - 1; j >= 0; j-- {
			iv := ws.Invoices[j]
			itemsJSON, err := json.Marshal(iv.Items)
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(`INSERT INTO invoices (id, workspace_id, number, company_name, company_address, items_json, amount, status, due_date, created_at, bank_name, bank_account_name, bank_account_number)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				idGen("iv-"), wsID, iv.Number, iv.CompanyName, iv.CompanyAddress, string(itemsJSON), itemsTotal(iv.Items),
				iv.Status, iv.DueDate, iv.CreatedAt,
				iv.BankDetail.BankName, iv.BankDetail.AccountName, iv.BankDetail.AccountNumber); err != nil {
				return nil, err
			}
		}
	}

	var active *string
	if firstWsID != "" {
		active = &firstWsID
	}
	if _, err := s.db.Exec(`UPDATE settings SET active_workspace_id = ?, default_model = 'claude-sonnet-5' WHERE id = 1`, active); err != nil {
		return nil, err
	}
	return s.Workspaces()
}

// wt is a factory for seed worktrees.
func wt(branch, base string, ahead, behind int, model, state, task string,
	tokens, elapsed, added, removed, files int, lines []domain.TermLine, pending ...string) domain.Worktree {
	w := domain.Worktree{
		Branch: branch, Base: base, Ahead: ahead, Behind: behind, Model: model,
		State: state, Task: task, Tokens: tokens, Elapsed: elapsed, Added: added,
		Removed: removed, Files: files, Lines: lines,
	}
	if len(pending) > 0 {
		p := pending[0]
		w.Pending = &p
	}
	return w
}

func seedCompanies() []domain.Company {
	return []domain.Company{
		{Name: "Umbrella LLC", ShortAddress: "Jl. Sudirman No. 25, Jakarta Selatan"},
		{Name: "Northwind Traders", ShortAddress: "500 Market St, San Francisco, CA"},
	}
}

func seedBanks() []domain.Bank {
	return []domain.Bank{
		{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"},
	}
}

func ln(rows ...[2]string) []domain.TermLine {
	out := make([]domain.TermLine, len(rows))
	for i, r := range rows {
		out[i] = domain.TermLine{K: r[0], T: r[1]}
	}
	return out
}

func seedWorkspaces() []domain.Workspace {
	return []domain.Workspace{
		{
			Name: "Acme",
			News: []domain.NewsItem{
				{Source: "The Verge", Title: "OpenAI ships agent API v2 with native tool use", Tag: "AI", Time: "25m", Unread: true},
				{Source: "Stripe Blog", Title: "Instant payouts expand to 12 more countries", Tag: "Payments", Time: "2h", Unread: true},
				{Source: "Hacker News", Title: "Postgres 18 released — async I/O and faster vacuum", Tag: "Eng", Time: "5h", Unread: true},
				{Source: "TechCrunch", Title: "Seed rounds rebound in Q2 as AI infra heats up", Tag: "Business", Time: "8h", Unread: false},
				{Source: "Vercel", Title: "Edge runtime adds native WebSocket support", Tag: "Eng", Time: "1d", Unread: false},
				{Source: "Bloomberg", Title: "Fed holds rates; SMB lending expected to loosen", Tag: "Finance", Time: "1d", Unread: false},
			},
			Todos: []domain.Todo{
				{Text: "Review Q2 payroll before Friday", Done: false, Priority: "high"},
				{Text: "Sign the office lease addendum", Done: false, Priority: "high"},
				{Text: "Send March retainer invoice to Northwind", Done: false, Priority: "normal"},
				{Text: "Onboard contractor — accounts + repo access", Done: false, Priority: "normal"},
				{Text: "File quarterly sales tax", Done: false, Priority: "high"},
				{Text: "Renew SSL cert for staging", Done: true, Priority: "low"},
			},
			Invoices: []domain.Invoice{
				{Number: "INV-1043", CompanyName: "Umbrella LLC", CompanyAddress: "Jl. Sudirman No. 25, Jakarta Selatan", Items: []domain.InvoiceItem{{Description: "Backend API development", Quantity: 1, UnitPrice: 5600000}}, Status: "draft", CreatedAt: "2026-07-06", DueDate: "2026-07-20", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
				{Number: "INV-1042", CompanyName: "Northwind Traders", CompanyAddress: "500 Market St, San Francisco, CA", Items: []domain.InvoiceItem{{Description: "Sprint retainer — July", Quantity: 1, UnitPrice: 8500000}}, Status: "sent", CreatedAt: "2026-06-28", DueDate: "2026-07-12", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
				{Number: "INV-1040", CompanyName: "Initech", CompanyAddress: "", Items: []domain.InvoiceItem{{Description: "Bug-fix retainer", Quantity: 1, UnitPrice: 3200000}}, Status: "overdue", CreatedAt: "2026-06-01", DueDate: "2026-06-15", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
				{Number: "INV-1041", CompanyName: "Globex Corp", CompanyAddress: "", Items: []domain.InvoiceItem{{Description: "Platform migration", Quantity: 1, UnitPrice: 12400000}}, Status: "paid", CreatedAt: "2026-06-14", DueDate: "2026-06-28", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
				{Number: "INV-1039", CompanyName: "Soylent Inc", CompanyAddress: "", Items: []domain.InvoiceItem{{Description: "Q2 engineering retainer", Quantity: 1, UnitPrice: 9800000}}, Status: "paid", CreatedAt: "2026-05-27", DueDate: "2026-06-10", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
			},
			Projects: []domain.Project{
				{
					Name: "web-app", Repo: "acme/web", Path: "~/dev/web-app", Expanded: true,
					Worktrees: []domain.Worktree{
						wt("feat/jwt-rotation", "main", 9, 0, "claude-sonnet-5", "running", "Implement key rotation for JWT signing with a 24h grace window; migrate verify path to support kid lookup.", 184320, 734, 162, 31, 7, ln(
							[2]string{"sys", "● planning: 4 steps"},
							[2]string{"file", "edit  src/server/auth/jwt.ts (+44 −12)"},
							[2]string{"cmd", "$ pnpm test -- auth.spec.ts"},
							[2]string{"ok", "✓ 23 passed (3.1s)"},
							[2]string{"out", "generating rotation keystore…"},
						)),
						wt("feat/rate-limit", "main", 4, 0, "claude-opus-4-8", "waiting", "Add a sliding-window rate limiter (Redis) to all /auth routes, 20 req/min per IP.", 96100, 412, 58, 4, 3, ln(
							[2]string{"out", "wrote src/server/mw/ratelimit.ts"},
							[2]string{"cmd", "$ prisma migrate dev --name add_rate_limits"},
							[2]string{"warn", "migration touches production-shaped table"},
							[2]string{"sys", "● awaiting confirmation"},
						), "Apply migration `add_rate_limits` to the staging database? This alters table `auth_attempts`."),
						wt("fix/checkout-flake", "main", 3, 1, "claude-sonnet-5", "running", "Track down and fix the flaky checkout Playwright spec that fails ~1 in 5 CI runs.", 132480, 902, 41, 67, 5, ln(
							[2]string{"cmd", "$ pnpm e2e checkout.spec.ts --repeat 20"},
							[2]string{"out", "run 14/20 …"},
							[2]string{"err", "✗ timeout waiting for #pay-btn (5000ms)"},
							[2]string{"sys", "● adding explicit await for network idle"},
						)),
						wt("feat/audit-log", "main", 1, 0, "claude-haiku-4-5", "running", "Add an append-only audit log for admin actions, write to a separate table.", 18400, 96, 26, 2, 2, ln(
							[2]string{"file", "create src/server/audit.ts"},
							[2]string{"out", "wiring middleware…"},
						)),
					},
				},
				{
					Name: "api", Repo: "acme/api", Path: "~/dev/api", Expanded: false,
					Worktrees: []domain.Worktree{
						wt("feat/orders-pagination", "main", 6, 0, "claude-sonnet-5", "running", "Add cursor-based pagination to GET /api/orders with a stable created_at + id sort.", 71200, 388, 88, 12, 4, ln(
							[2]string{"file", "edit  src/routes/orders.ts (+52 −8)"},
							[2]string{"out", "adding cursor codec (base64)"},
							[2]string{"cmd", "$ pnpm test -- orders"},
							[2]string{"out", "running 31 tests…"},
						)),
						wt("chore/backfill-index", "main", 1, 0, "gpt-5", "idle", "Create a concurrent index on orders(created_at, id) and backfill nulls.", 24800, 140, 9, 0, 1, ln(
							[2]string{"out", "drafted migration"},
							[2]string{"sys", "● paused — waiting on schema review"},
						)),
						wt("chore/react-19", "main", 2, 4, "o4-mini", "error", "Bump react & react-dom to 19, resolve peer deps, fix breaking ref/forwardRef changes.", 58900, 261, 120, 140, 18, ln(
							[2]string{"cmd", "$ pnpm up react react-dom@19"},
							[2]string{"err", "✗ peer dep conflict: @testing-library/react@14"},
							[2]string{"err", "ERESOLVE could not resolve"},
							[2]string{"out", "exit code 1"},
						)),
					},
				},
				{
					Name: "mobile", Repo: "acme/mobile", Path: "~/dev/mobile", Expanded: false,
					Worktrees: []domain.Worktree{
						wt("feat/dark-mode", "main", 11, 0, "claude-sonnet-5", "running", "Generate semantic color tokens for dark mode and wire them through the theme provider.", 210400, 1284, 244, 40, 16, ln(
							[2]string{"file", "create tokens/dark.ts"},
							[2]string{"out", "mapping 84 semantic tokens"},
							[2]string{"ok", "✓ contrast AA on 81/84"},
							[2]string{"warn", "⚠ 3 tokens below 4.5:1"},
						)),
						wt("chore/image-pipeline", "main", 5, 0, "claude-haiku-4-5", "running", "Move thumbnail generation to sharp with webp output and a CDN cache key.", 43900, 196, 57, 14, 6, ln(
							[2]string{"cmd", "$ node scripts/thumbs.mjs"},
							[2]string{"out", "processed 248/1200 images"},
							[2]string{"out", "avg 41ms/image"},
						)),
					},
				},
			},
		},
		{
			Name: "Side projects",
			News: []domain.NewsItem{
				{Source: "Astro Blog", Title: "Astro 5.2 improves content layer caching", Tag: "Eng", Time: "3h", Unread: true},
				{Source: "Indie Hackers", Title: "How a solo dev reached $5k MRR with a blog", Tag: "Business", Time: "1d", Unread: false},
			},
			Todos: []domain.Todo{
				{Text: "Publish the 2026 roadmap post", Done: false, Priority: "normal"},
				{Text: "Set up Plausible analytics", Done: true, Priority: "low"},
			},
			Invoices: []domain.Invoice{
				{Number: "INV-2001", CompanyName: "Consulting — retainer", CompanyAddress: "", Items: []domain.InvoiceItem{{Description: "Consulting retainer", Quantity: 1, UnitPrice: 1500000}}, Status: "sent", CreatedAt: "2026-07-04", DueDate: "2026-07-18", BankDetail: domain.BankDetail{BankName: "BCA", AccountName: "Andi Syahruddin", AccountNumber: "6281892573"}},
			},
			Projects: []domain.Project{
				{
					Name: "blog", Repo: "me/blog", Path: "~/dev/blog", Expanded: true,
					Worktrees: []domain.Worktree{
						wt("draft/2026-roadmap", "main", 2, 0, "claude-sonnet-5", "running", "Draft the 2026 engineering roadmap post from the planning notes and the Q4 retro.", 12400, 84, 18, 3, 1, ln(
							[2]string{"file", "create content/2026-roadmap.md"},
							[2]string{"out", "outlining 6 sections…"},
						)),
						wt("chore/upgrade-astro", "main", 1, 0, "claude-haiku-4-5", "idle", "Upgrade Astro to v5 and migrate the content collections config.", 6200, 52, 11, 5, 2, ln(
							[2]string{"cmd", "$ pnpm up astro@5"},
							[2]string{"sys", "● paused"},
						)),
					},
				},
			},
		},
	}
}
