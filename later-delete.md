# dbt Diff & Impact Report — Umar's `uams-dbt` vs. project `dbt/uams`

**Date:** 2026-07-12
**Compared:**
- **EXISTING** (source of truth): `dbt/uams`
- **INCOMING** (Umar): `docs/umar-dms/uams-dbt`

**Method:** 8-agent comparison workflow (`dbt-compare-umar`), one agent per layer/concern, every finding read from file and cross-checked with direct greps against `sql/`, `depo/domain/registry.py`, and `dbt/uams`.

---

## 0. Executive verdict

- **Umar's folder is a file snapshot, not a git branch.** Its `.git` is broken (`fatal: not a git repository` — missing `refs/heads/main`), so a naive `git log` from inside it actually reads *this* repo. There is no shared, usable history to merge from git.
- **It is a parallel re-platform of the same dbt project onto a third source system — Odoo ERP.** Data lineage becomes Depoharkan (CDC) + E-Tekkom (snapshot) **+ Odoo (snapshot)**. It is a *name-superset* of our project but built on a different — and in several places earlier/un-hardened — foundation.
- **A wholesale copy-over is not viable.** It would not compile (27 undefined `odoo_*` sources) and would violate **3 of 4** project non-negotiables, while deleting our SCD2 snapshots, custom data-quality tests, and two macros.
- **But there is real value to cherry-pick** (incremental E-Tekkom facts, wider column selections, richer docs) and a real future roadmap (Odoo integration + outbound-lifecycle facts) worth capturing as an epic.

---

## 1. Structural inventory (name-superset, but drops our safety nets)

| Layer | Shared (same filename) | Incoming-only (extra) | Existing-only (incoming lacks) |
|---|---|---|---|
| Staging | 31 (10 identical ignoring whitespace, 21 differ) | **+26 `stg_odoo_*`** | — |
| Silver | 31 (12 dims + 18 facts + `golden_asset_bridge`) | **+7 facts** + `audit_log.sql` **(as a model)** | — |
| Gold | 5 marts | **+2** (`mart_asset_by_satker`, `mart_lifecycle_by_category`) | — |
| Snapshots | — | — | **3 SCD2 snapshots** (company/contract/user) |
| Tests | — | dbt_utils / accepted_values additions | **`not_empty`, `snapshot_volume_drop`, `assert_overview_condition_totals`** |
| Macros | `generate_schema_name` (≈identical) | — | **`capture_audit_diff`, `normalize_serial`** |
| Config | — | `packages.yml` (dbt_utils 1.3.0), `on-run-end` grants, `+tags`, `run_e2e.sh`/`inject_dark.py`/dark CSS | `snapshot-paths`, vars `contract_expiry_days`/`overdue_days`, per-model grants |

---

## 2. Impact-diff table — what happens if we adopt each incoming change *as-is*

Severity legend: 🔴 breaking/regression · 🟡 needs adaptation · 🟢 safe/beneficial.
"NN" = violates a project Non-Negotiable (#1 audit_log raw DDL · #2 bronze append-only + dedup is staging's job · #3 registry↔bronze DDL 1:1).

### 2.1 Config & macros

| Item | Incoming | Existing | Impact if merged as-is | Sev | NN | Recommendation |
|---|---|---|---|---|---|---|
| Project name | `uams_dbt` v1.0.0 | `uams` v0.1.0 | Breaks `models:` block key + wider harness references to `uams` | 🔴 | — | Reject rename |
| `on-run-end` grants | Hook: `CREATE ROLE` + `revoke all on schema gold` + grant **4** marts | Per-model `grants={'select':['uams_ai_ro']}` on **2** marts + schema `GRANT` in `sql/04` | Broadens AI/RAG surface 2→4 marts; blanket revoke-all strips any other gold grant every build; grants 2 marts that don't exist here; conflicts with catalog-sync scope | 🔴 | — | Reject; keep per-model grants |
| `packages.yml` (dbt_utils 1.3.0) | Present | Absent | Adds a dependency; only useful if we adopt its tests | 🟡 | — | Optional — only with the test back-port |
| `+tags: [staging|silver|gold]` | Present | Absent | Cosmetic; aids `--select tag:` | 🟢 | — | Safe to adopt |
| `vars` | only `batch_date` | `contract_expiry_days: 30`, `overdue_days: 14` | Dropping ours breaks contract-expiry/overdue KPI logic that consumes them | 🔴 | — | Keep our vars |
| `profiles.yml` | host=localhost, user=`uams`, db=`uams_depoharkan_dev`, schema=`dbt_default` | host=`postgres`, user=`transform_user`, db=`warehouse`, schema=`silver` | Wrong connection identity for our compose stack | 🟡 | — | Keep ours |
| `generate_schema_name` | Bare macro | Same logic + doc comment | None (literal schemas preserved on both) | 🟢 | — | No change needed |
| `capture_audit_diff` macro | **Absent** | Present (only writer of `silver.audit_log`; used by ~27 models) | Silver audit trail never populated | 🔴 | #1 | Keep ours |
| `normalize_serial` macro | **Absent** | Present (upper + strip non-alphanumerics) | Cross-source serial matching becomes case/punctuation-fragile | 🔴 | — | Keep ours |
| Extra tooling (`run_e2e.sh`, `inject_dark.py`, dark CSS, README) | Present | Absent | Dev conveniences | 🟢 | — | Optional, keep beside — not into — `dbt/uams` |

### 2.2 Sources

| Item | Incoming | Existing | Impact if merged as-is | Sev | NN | Recommendation |
|---|---|---|---|---|---|---|
| `bronze` source tables | Same 31 **+ 27 `odoo_*`** (snapshot-shaped: leading `snapshot_date`, no `_airbyte_*`) | 31 (24 CDC + 7 E-Tekkom) | 27 sources with **no bronze DDL, no registry tuple, no loader** → dbt won't compile; breaks 3-way registry guard | 🔴 | #3 | Blocked — Odoo epic prerequisite |
| yml naming | single `_` (`_sources.yml`, `_staging_models.yml`, …) | double `__` (`_bronze__sources.yml`, …) | Cosmetic, but two parallel files if mixed | 🟡 | — | Keep our `__` names |
| Column docs volume | ~688 documented columns | ~249 | More documentation | 🟢 | — | Back-port onto our yml |

### 2.3 Staging (31 shared)

| Item | Incoming | Existing | Impact if merged as-is | Sev | NN | Recommendation |
|---|---|---|---|---|---|---|
| CDC dedup (~18 models + `stg_etekkom_assets`) | **Deletes** the `row_number() over (partition by id order by _airbyte_extracted_at desc) … _rn=1` CTE; `where deleted_at is null` only | `ranked` CTE keeps latest version | Emits duplicate CDC/snapshot versions → fans out every downstream silver/gold join | 🔴 | #2 | Keep our dedup |
| `stg_contracts` | Drops `contract_id`/`contract_number` renames + `updated_at`/`_airbyte_extracted_at` | Full column contract | Downstream contract models break | 🔴 | — | Keep ours |
| `stg_etekkom_assets` | Wider columns (`parent_site_area`, `acquisition_*`, `provider*`, `frequency_mhz`, …) | Narrower | Extra fields valid vs current bronze | 🟡 | — | Adopt columns **+ re-add snapshot_date dedup** |
| inline comments (`stg_assets`, `stg_spmb_details`) | Extra comments | None | Harmless | 🟢 | — | Optional |

### 2.4 Silver — dimensions (12 + audit_log)

| Item | Incoming | Existing | Impact if merged as-is | Sev | NN | Recommendation |
|---|---|---|---|---|---|---|
| `audit_log.sql` | **dbt `table` model** (`select … where false`) | Raw DDL in `sql/04` | Dropped + recreated **empty** on every `dbt build --select silver` → audit history destroyed | 🔴 | #1 | Reject; keep raw DDL |
| `dim_company` / `dim_contract` / `dim_user` | Direct staging read; `gen_random_uuid()` keys; no snapshot | SCD2-snapshot-backed; deterministic `dbt_scd_id`; audit hooks | Loses point-in-time history; keys change every rebuild (breaks stored FKs / idempotency) | 🔴 | — | Keep snapshot wrappers |
| ODOO union branches on `dim_asset`/`dim_category`/`dim_company`/`dim_contract` | Union `stg_odoo_*` | Odoo-free | Won't resolve (no odoo bronze/registry) | 🔴 | #3 | Blocked — Odoo epic |
| Audit hooks on dims | Dropped | `capture_audit_pre/post` | Silently drops silver audit capture | 🔴 | #1 | Keep hooks |
| `category_type` / `satwil_type` / dropped `satwil.parent_id` | Reverted to raw passthrough | Deliberate dictionary corrections | Reintroduces the exact bugs the corrections fixed | 🔴 | — | Keep our derivations |
| `is_active`/friendly-rename columns | Added | — | Additive/cosmetic | 🟢 | — | Optional adapt |

### 2.5 Silver — facts (18 shared + bridge + 7 new)

| Item | Incoming | Existing | Impact if merged as-is | Sev | NN | Recommendation |
|---|---|---|---|---|---|---|
| Surrogate keys (all facts) | `gen_random_uuid()::varchar` | `md5('prefix|'||id)::uuid` deterministic | Non-idempotent SKs every rebuild; breaks audit-diff + bridge back-fill | 🔴 | — | Keep md5 |
| Audit hooks (all facts) | Dropped | `capture_audit_pre/post` | Fact-level audit capture lost | 🔴 | #1 | Keep hooks |
| `source_system` + ODOO union (fact_spmb/_detail/_status, fact_sipm, fact_rfid_unit, fact_gate_in) | Added | — | Reads `stg_odoo_*` → won't compile | 🔴 | #3 | Blocked — Odoo epic |
| 6 E-Tekkom snapshot facts | `incremental` delete+insert, deterministic md5 | full `table` rebuild | **Improvement** (perf); keeps deterministic ids | 🟡 | — | Adopt **+ re-add audit hooks** |
| `fact_etekkom_device_snapshot` columns | Wider (`parent_site_area`, `provider`, lat/lon, `tower_height`, …) | Narrower | Extra fields if bronze has them | 🟡 | — | Adopt if dictionary supports |
| `golden_asset_bridge` | Tri-source; **exact-serial match** (drops `normalize_serial`); hardcoded `silver.dim_asset` in post-hook | `normalize_serial()` match; `ref()`-based post-hook | Case/punctuation-variant serials silently fail to bridge → fewer golden matches, no signal | 🔴 | — | Keep normalize_serial version |
| 7 new facts (`fact_asset_unit`, `fact_gate_out`, `fact_odoo_asset`, `fact_rencana_distribusi[_line]`, `fact_sbpb`, `fact_surat_jalan_out`) | New capability (asset-360 OBT + outbound lifecycle) | — | All odoo/new-bronze dependent → won't compile | 🟣 | #3 | Future epic (net-new scope) |

### 2.6 Gold (5 shared + 2 new)

| Item | Incoming | Existing | Impact if merged as-is | Sev | NN | Recommendation |
|---|---|---|---|---|---|---|
| `mart_asset_qty` Depoharkan measure | Silently changes `received_qty` (document qty) → `COUNT(*)` per unit; adds ODOO branch + `category_code`; renames `unique_id`→`etekkom_unique_id` | 3-branch document-qty model | **KPI redefinition** presented as a refactor; downstream numbers change meaning | 🔴 | — | Do not adopt silently; decide KPI intent |
| `mart_asset_overview` | Rolls up `mart_asset_qty` + `fact_asset_unit` (not `mart_asset_golden`); redefines `cond_unknown`; **drops** `condition_coverage_pct`/`units_condition_known` | Rolls up qty + golden; has coverage metrics + grants | Loses coverage metrics; depends on missing `fact_asset_unit` | 🔴 | #3 | Keep ours |
| `mart_kpi_contract` | Adds `source_system`; expects reshaped `dim_contract`/`dim_company` (native `contract_value`, `is_current`, `source_system`) | Works on current dim shape | Won't resolve against current silver | 🟡 | — | Blocked pending dim reshape |
| `mart_spmb_lifecycle` | Adds `source_system` + `n_units_gated_out`/`n_units_distributed`/`n_sbpb` | Existing funnel measures | New measures ref 4 facts absent here | 🟡 | #3 | Blocked pending new facts |
| `mart_asset_by_satker` (new) | AI mart, grain category×satker×condition; reads only `fact_asset_unit` | — | Blocked (no `fact_asset_unit`) | 🟣 | #3 | Future epic |
| `mart_lifecycle_by_category` (new) | AI mart, source×category×satker funnel; reads `fact_odoo_asset` + source_system-tagged facts | — | Blocked (missing facts/columns) | 🟣 | #3 | Future epic |
| AI grant surface | 4 marts via `on-run-end` | 2 marts via per-model config | Broadens RAG surface; conflicts with catalog sync | 🔴 | — | Keep 2-mart scope |

### 2.7 Structural safety nets (existing-only — pure loss if dropped)

| Item | Purpose | Impact if we adopt incoming (which lacks it) | Sev |
|---|---|---|---|
| `snapshots/dim_company_snapshot` | SCD2 history + audit for company | No point-in-time company history; non-stable keys | 🔴 |
| `snapshots/dim_contract_snapshot` | SCD2 for the KPI-relevant contract fields (value/status/end_date/currency) | No contract change history; unstable contract_sk | 🔴 |
| `snapshots/dim_user_snapshot` | SCD2 for user (underpins contract↔company lineage) | No user history; unstable user_sk | 🔴 |
| `tests/assert_overview_condition_totals.sql` | Asserts condition counts ≥ qty_deployed | Zero-coverage overview (real ROUTER defect) goes silent | 🔴 |
| `tests/generic/not_empty.sql` (16 call-sites) | Fails on empty relations | "Green pipeline, empty warehouse" passes undetected | 🔴 |
| `tests/generic/snapshot_volume_drop.sql` (6 E-Tekkom sources) | Fails on >50% snapshot row drop | Silent truncation (the max_pages cap) undetected | 🔴 |
| `macros/capture_audit_diff.sql` | Only writer of `silver.audit_log` (~27 models) | Audit table permanently empty | 🔴 |
| `macros/normalize_serial.sql` | Canonical serial matching | Cross-source golden matches regress | 🔴 |

---

## 3. Non-negotiable conflicts (the hard blockers)

1. **#1 audit_log must be raw DDL** — incoming ships it as a `table` model (`where false`) → wiped every silver rebuild; and drops all `capture_audit_*` hooks.
2. **#2 bronze append-only / dedup is staging's job** — incoming removes dedup CTEs from ~18 CDC staging models.
3. **#3 registry ↔ bronze DDL 1:1** — 27 `stg_odoo_*` + odoo union branches + 7 new facts read `bronze.odoo_*` tables with no DDL, no registry tuple, no loader.

---

## 4. Tiered merge plan (recommended path)

| Tier | Scope | Risk | Effort |
|---|---|---|---|
| 🟢 **Take now** | `+tags`; back-port richer **column docs + dbt_utils/accepted_values tests** *on top of* our yml (keep `not_empty`/`snapshot_volume_drop`) | Low (additive) | Small |
| 🟡 **Adapt then take** | Incremental delete+insert for the 6 E-Tekkom facts; wider `stg_etekkom_assets` / `fact_etekkom_device_snapshot` columns — **re-add dedup + md5 keys + audit hooks** | Medium (needs compile/test) | Medium |
| 🟣 **Epic (not a merge)** | Odoo ERP ingestion: bronze DDL + dictionary + registry + loader → 27 staging + odoo facts + 2 marts; and outbound-lifecycle facts. Priority subset = the ~9 "REAL/populated" odoo models (`asset_custom` 90k rows, `location`, `gate_*_real`, SAKTI bridge); the other ~18 are self-labeled "empty until export" scaffolding | High (multi-layer) | Large |
| 🔴 **Reject** | `audit_log.sql` as model; `gen_random_uuid()` keys; dedup removal; dropping snapshots/tests/macros; project rename; `on-run-end` grant block; reverted dictionary corrections | — | — |

---

## 5. Merge executed (branch `merge/umar-dbt-safe-subset`)

Per the tiered plan, the **🟢 safe subset was actually merged** into `dbt/uams` on branch `merge/umar-dbt-safe-subset` (off `main`, uncommitted — review with `git diff main`). Only changes that are additive, verifiable statically, and violate **no** non-negotiable were applied:

| # | File | Change | From Umar | Verification |
|---|---|---|---|---|
| 1 | `dbt/uams/dbt_project.yml` | Added `+tags: ["staging"|"silver"|"gold"]` per layer | Yes (his `+tags`) | Valid dbt config; cannot affect model output |
| 2 | `dbt/uams/models/staging/stg_etekkom_assets.sql` | Widened SELECT from 13 → 28 columns to expose the full `bronze.etekkom_assets` contract to Silver (`parent_site_area`, `acquisition_*`, `provider*`, `system`, `frequency_mhz`, `transmit_power_watt`, `gain_db`, `receiver_gain_db`, `tower_height`, `related_*`, `site_name`, `description`) | Yes (his wider column set) — **adapted**: our dedup `ranked`/`_rn=1` CTE **retained** (Umar's version dropped it, a #2 violation) | All 28 columns confirmed present in `bronze.etekkom_assets` DDL (`sql/04`); `_staging__models.yml` has no contract enforcement on this model; extra columns are non-breaking downstream |

**Deliberately NOT merged** (would break the build or a non-negotiable — see §2/§3): `audit_log.sql` as a model, `gen_random_uuid()` keys, dedup removal on the other ~18 staging models, snapshot/test/macro deletions, the project rename, the `on-run-end` grant block, the reverted dictionary corrections, and everything Odoo-dependent (27 staging + odoo facts/dims + 2 marts + `source_system` branches) which has no bronze/registry/loader here.

**Not verifiable locally:** `dbt parse`/`build` could not run in this environment (no `dbt-postgres` adapter; dbt runs in the container `/opt/dbt-venv`). A `dbt build --select staging` in the container should be run to confirm before promoting the branch.

---

## Appendix — shared staging: 10 identical / 21 differ

The 21 differing shared staging models differ almost entirely on the dedup CTE (see 2.3). `stg_contracts` and `stg_etekkom_assets` additionally differ on column contract. All shared models read `source('bronze', …)` as views on both sides (no source-vs-ref drift, same materialization).
