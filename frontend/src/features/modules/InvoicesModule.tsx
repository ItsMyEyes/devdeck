import { Fragment, useState } from 'react'
import { Download, Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/ui/pill'
import { Select } from '@/components/ui/select'
import { INVST } from '@/lib/constants'
import { fmtDate, fmtMonthYear, fmtRupiah, isPastDue } from '@/lib/format'
import { downloadInvoice } from '@/lib/invoiceDocument'
import { cn } from '@/lib/utils'
import type { Invoice, InvoiceStatus } from '@/store/types'
import {
  useCreateBank,
  useCreateCompany,
  useCreateInvoice,
  useDeleteInvoice,
  useUpdateInvoice,
  useWorkspace,
} from '@/features/data/queries'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { InvoicesEmpty } from '@/features/screens/InvoicesEmpty'
import { BankPicker } from './BankPicker'
import { CompanyPicker } from './CompanyPicker'
import { FinanceAnalysisTab } from './finance/FinanceAnalysisTab'
import { ModuleHeader } from './ModuleHeader'
import { RecurringTab } from './recurring/RecurringTab'

const STATUS_OPTIONS = (['draft', 'sent', 'paid', 'overdue'] as InvoiceStatus[]).map((s) => ({
  value: s,
  label: INVST[s].label,
}))

interface DraftItem {
  description: string
  quantity: string
  unitPrice: string
}

interface Draft {
  editId: string | null
  number: string
  companyName: string
  companyAddress: string
  items: DraftItem[]
  dueDate: string
  status: InvoiceStatus
  bankName: string
  bankAccountName: string
  bankAccountNumber: string
}

function emptyItem(): DraftItem {
  return { description: '', quantity: '1', unitPrice: '' }
}

function itemTotal(it: DraftItem): number {
  return (parseFloat(it.quantity) || 0) * (parseFloat(it.unitPrice.replace(/[^0-9.]/g, '')) || 0)
}

interface MonthGroup {
  ym: string
  label: string
  total: number
  items: Invoice[]
}

/** Groups invoices by createdAt's YYYY-MM, newest month first, preserving each invoice's existing order within its month. */
function groupInvoicesByMonth(invoices: Invoice[]): MonthGroup[] {
  const groups = new Map<string, MonthGroup>()
  for (const iv of invoices) {
    const ym = iv.createdAt.slice(0, 7)
    let group = groups.get(ym)
    if (!group) {
      group = { ym, label: fmtMonthYear(iv.createdAt), total: 0, items: [] }
      groups.set(ym, group)
    }
    group.total += iv.amount
    group.items.push(iv)
  }
  return [...groups.values()].sort((a, b) => (a.ym < b.ym ? 1 : -1))
}

/** Per-workspace invoicing: reusable company/bank presets, a job-details table, and per-invoice download. */
export function InvoicesModule({ wsId }: { wsId: string }) {
  const q = useWorkspace(wsId)
  const createInvoice = useCreateInvoice()
  const updateInvoice = useUpdateInvoice()
  const deleteInvoice = useDeleteInvoice()
  const createCompany = useCreateCompany()
  const createBank = useCreateBank()

  const [draft, setDraft] = useState<Draft | null>(null)
  const [tab, setTab] = useState<'invoices' | 'recurring' | 'finance'>('invoices')

  if (q.isPending) return <DataLoading label="loading invoices…" />
  if (q.isError) return <DataError error={q.error} onRetry={() => q.refetch()} />

  const workspace = q.data
  const invoices = workspace?.invoices ?? []
  const recurringTemplates = workspace?.recurringTemplates ?? []
  const total = invoices.reduce((sum, iv) => sum + iv.amount, 0)
  const outstanding = invoices
    .filter((iv) => iv.status !== 'paid' && iv.status !== 'draft')
    .reduce((sum, iv) => sum + iv.amount, 0)

  function openNew() {
    setDraft({
      editId: null,
      number: 'INV-' + (1044 + invoices.length),
      companyName: '',
      companyAddress: '',
      items: [emptyItem()],
      dueDate: '',
      status: 'draft',
      bankName: '',
      bankAccountName: '',
      bankAccountNumber: '',
    })
  }

  function openEdit(iv: Invoice) {
    setDraft({
      editId: iv.id,
      number: iv.number,
      companyName: iv.companyName,
      companyAddress: iv.companyAddress,
      items: iv.items.length
        ? iv.items.map((it) => ({
            description: it.description,
            quantity: String(it.quantity),
            unitPrice: String(it.unitPrice),
          }))
        : [emptyItem()],
      dueDate: iv.dueDate,
      status: iv.status,
      bankName: iv.bankDetail.bankName,
      bankAccountName: iv.bankDetail.accountName,
      bankAccountNumber: iv.bankDetail.accountNumber,
    })
  }

  function updateItem(index: number, patch: Partial<DraftItem>) {
    if (!draft) return
    setDraft({ ...draft, items: draft.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) })
  }

  function addItem() {
    if (!draft) return
    setDraft({ ...draft, items: [...draft.items, emptyItem()] })
  }

  function removeItem(index: number) {
    if (!draft || draft.items.length <= 1) return
    setDraft({ ...draft, items: draft.items.filter((_, i) => i !== index) })
  }

  function saveCompanyPreset() {
    if (!draft || !draft.companyName.trim()) return
    createCompany.mutate({ name: draft.companyName.trim(), shortAddress: draft.companyAddress.trim() })
    toast.success('Company saved as preset')
  }

  function saveBankPreset() {
    if (!draft || !draft.bankName.trim() || !draft.bankAccountNumber.trim()) return
    createBank.mutate({
      bankName: draft.bankName.trim(),
      accountName: draft.bankAccountName.trim(),
      accountNumber: draft.bankAccountNumber.trim(),
    })
    toast.success('Bank saved as preset')
  }

  function save() {
    if (!draft) return
    const bankName = draft.bankName.trim()
    const bankAccountName = draft.bankAccountName.trim()
    const bankAccountNumber = draft.bankAccountNumber.trim()
    if (!bankName || !bankAccountName || !bankAccountNumber) {
      toast.error('Bank detail (bank name, account name, account number) is required')
      return
    }
    if (!draft.dueDate) {
      toast.error('Due date is required')
      return
    }
    const companyName = draft.companyName.trim() || 'Untitled client'
    const companyAddress = draft.companyAddress.trim()
    const items = draft.items
      .filter((it) => it.description.trim())
      .map((it) => ({
        description: it.description.trim(),
        quantity: parseFloat(it.quantity) || 0,
        unitPrice: parseFloat(it.unitPrice.replace(/[^0-9.]/g, '')) || 0,
      }))
    if (items.length === 0) {
      toast.error('At least one job-detail line item is required')
      return
    }
    const number = draft.number.trim() || 'INV-' + (1044 + invoices.length)
    const body = {
      number,
      companyName,
      companyAddress,
      items,
      dueDate: draft.dueDate,
      status: draft.status,
      bankName,
      bankAccountName,
      bankAccountNumber,
    }
    if (draft.editId) {
      updateInvoice.mutate({ id: draft.editId, patch: body }, { onSuccess: () => setDraft(null) })
    } else {
      createInvoice.mutate({ wsId, body }, { onSuccess: () => setDraft(null) })
    }
  }

  const saving = createInvoice.isPending || updateInvoice.isPending
  const draftGrandTotal = draft ? draft.items.reduce((sum, it) => sum + itemTotal(it), 0) : 0
  const monthGroups = groupInvoicesByMonth(invoices)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModuleHeader
        title="Invoices"
        meta={
          invoices.length
            ? `${invoices.length} · ${fmtRupiah(total)} total · ${fmtRupiah(outstanding)} outstanding`
            : undefined
        }
        actions={
          tab === 'invoices' ? (
            <Button size="sm" onClick={openNew}>
              <Plus size={13} />
              New invoice
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-none items-center gap-1 border-b border-loom-border px-4 py-2">
        {(
          [
            { key: 'invoices', label: 'Invoices' },
            { key: 'recurring', label: 'Recurring' },
            { key: 'finance', label: 'Finance Analysis' },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'cursor-pointer rounded-md px-2.5 py-1.5 font-mono text-[11.5px] transition-colors',
              tab === t.key ? 'bg-loom-accent/10 text-loom-fg' : 'text-loom-muted hover:text-loom-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'recurring' ? <RecurringTab wsId={wsId} templates={recurringTemplates} /> : null}
      {tab === 'finance' ? <FinanceAnalysisTab invoices={invoices} /> : null}

      {tab === 'invoices' && draft ? (
        <div className="flex-none border-b border-loom-border bg-loom-card/40 px-4 py-3">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="font-mono text-[11.5px] text-loom-muted-2">
              {draft.editId ? 'Edit invoice' : 'New invoice'}
            </span>
            <button
              onClick={() => setDraft(null)}
              aria-label="Close"
              className="cursor-pointer p-0.5 text-loom-muted-2 hover:text-loom-fg"
            >
              <X size={14} />
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Number</span>
              <Input
                value={draft.number}
                onChange={(e) => setDraft({ ...draft, number: e.target.value })}
                placeholder="INV-1044"
                className="w-[120px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Due date</span>
              <Input
                type="date"
                value={draft.dueDate}
                onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                className="w-[150px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Status</span>
              <div className="w-[120px]">
                <Select
                  value={draft.status}
                  onValueChange={(v) => setDraft({ ...draft, status: v as InvoiceStatus })}
                  options={STATUS_OPTIONS}
                  aria-label="Status"
                />
              </div>
            </label>

            <div className="basis-full" />

            <label className="flex min-w-[180px] flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Company (bill to)</span>
              <Input
                value={draft.companyName}
                onChange={(e) => setDraft({ ...draft, companyName: e.target.value })}
                placeholder="Umbrella LLC"
              />
            </label>
            <label className="flex min-w-[220px] flex-1 flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Short address</span>
              <Input
                value={draft.companyAddress}
                onChange={(e) => setDraft({ ...draft, companyAddress: e.target.value })}
                placeholder="Jakarta, Indonesia"
              />
            </label>
            <CompanyPicker onPick={(c) => setDraft({ ...draft, companyName: c.name, companyAddress: c.shortAddress })} />
            <Button size="sm" variant="secondary" onClick={saveCompanyPreset} disabled={createCompany.isPending}>
              + Save preset
            </Button>

            <div className="basis-full" />

            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Bank name *</span>
              <Input
                value={draft.bankName}
                onChange={(e) => setDraft({ ...draft, bankName: e.target.value })}
                placeholder="BCA"
                className="w-[140px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Account name *</span>
              <Input
                value={draft.bankAccountName}
                onChange={(e) => setDraft({ ...draft, bankAccountName: e.target.value })}
                placeholder="Andi Syahruddin"
                className="w-[160px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] text-loom-dim">Account number *</span>
              <Input
                value={draft.bankAccountNumber}
                onChange={(e) => setDraft({ ...draft, bankAccountNumber: e.target.value })}
                placeholder="6281892573"
                className="w-[160px]"
              />
            </label>
            <BankPicker
              onPick={(b) =>
                setDraft({ ...draft, bankName: b.bankName, bankAccountName: b.accountName, bankAccountNumber: b.accountNumber })
              }
            />
            <Button size="sm" variant="secondary" onClick={saveBankPreset} disabled={createBank.isPending}>
              + Save preset
            </Button>

            <div className="basis-full" />

            <div className="w-full">
              <span className="font-mono text-[10px] text-loom-dim">Job details</span>
              <table className="mt-1 w-full border-collapse text-[12px]">
                <thead>
                  <tr className="text-left font-mono text-[10px] text-loom-dim uppercase">
                    <th className="w-8 py-1">No.</th>
                    <th className="py-1">Deskripsi Pekerjaan (Jasa Engineer)</th>
                    <th className="w-20 py-1 text-right">Kuantitas</th>
                    <th className="w-32 py-1 text-right">Harga Satuan (Rp)</th>
                    <th className="w-32 py-1 text-right">Total (Rp)</th>
                    <th className="w-8 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {draft.items.map((it, i) => (
                    <tr key={i}>
                      <td className="py-1 text-loom-dim">{i + 1}</td>
                      <td className="py-1 pr-1">
                        <Input
                          value={it.description}
                          onChange={(e) => updateItem(i, { description: e.target.value })}
                          placeholder="Backend API development"
                        />
                      </td>
                      <td className="py-1 pr-1">
                        <Input
                          value={it.quantity}
                          onChange={(e) => updateItem(i, { quantity: e.target.value })}
                          className="text-right"
                        />
                      </td>
                      <td className="py-1 pr-1">
                        <Input
                          value={it.unitPrice}
                          onChange={(e) => updateItem(i, { unitPrice: e.target.value })}
                          placeholder="0"
                          className="text-right"
                        />
                      </td>
                      <td className="py-1 text-right font-mono text-loom-fg">{fmtRupiah(itemTotal(it))}</td>
                      <td className="py-1 text-right">
                        <button
                          onClick={() => removeItem(i)}
                          aria-label="Remove line item"
                          className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-red-soft"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1.5 flex items-center justify-between">
                <button
                  onClick={addItem}
                  className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-loom-accent-soft hover:underline"
                >
                  <Plus size={12} />
                  Add line item
                </button>
                <span className="font-mono text-[12.5px] text-loom-fg">
                  Grand total: {fmtRupiah(draftGrandTotal)}
                </span>
              </div>
            </div>

            <Button size="lg" disabled={saving} onClick={save}>
              {draft.editId ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      ) : null}

      {tab === 'invoices' && (invoices.length === 0 ? (
        <InvoicesEmpty />
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <table className="w-full min-w-[900px] border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-loom-border text-left font-mono text-[10px] tracking-wide text-loom-dim uppercase">
                <th className="px-3 py-2 font-medium">Number</th>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Bank detail</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {monthGroups.map((group) => (
                <Fragment key={group.ym}>
                  <tr className="border-b border-loom-border bg-loom-card/30">
                    <td colSpan={8} className="px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] font-semibold tracking-wide text-loom-fg-2 uppercase">
                          {group.label}
                        </span>
                        <span className="font-mono text-[12px] font-semibold text-loom-fg">
                          {fmtRupiah(group.total)}
                        </span>
                      </div>
                    </td>
                  </tr>
                  {group.items.map((iv) => {
                    const st = INVST[iv.status]
                    const overdue = iv.status !== 'paid' && isPastDue(iv.dueDate)
                    return (
                      <tr
                        key={iv.id}
                        className="border-b border-loom-border-card last:border-none hover:bg-loom-card/50"
                      >
                        <td className="px-3 py-2.5 font-mono text-[11.5px] whitespace-nowrap text-loom-muted-2">
                          {iv.number}
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2.5 text-loom-fg">
                          {iv.companyName || '—'}
                        </td>
                        <td className="max-w-[180px] px-3 py-2.5 text-loom-dim">
                          <div className="truncate">{iv.bankDetail.bankName || '—'}</div>
                          <div className="truncate font-mono text-[10.5px] text-loom-dim">
                            {iv.bankDetail.accountNumber}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap text-loom-dim">
                          {fmtDate(iv.createdAt)}
                        </td>
                        <td
                          className={`px-3 py-2.5 font-mono text-[11px] whitespace-nowrap ${
                            overdue ? 'text-loom-red-soft' : 'text-loom-dim'
                          }`}
                        >
                          {fmtDate(iv.dueDate)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-[12px] whitespace-nowrap text-loom-fg">
                          {fmtRupiah(iv.amount)}
                        </td>
                        <td className="px-3 py-2.5">
                          <Pill color={st.color}>{st.label}</Pill>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-0.5">
                            <button
                              onClick={() => downloadInvoice(iv)}
                              aria-label="Download invoice"
                              title="Download"
                              className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-accent-soft"
                            >
                              <Download size={13} />
                            </button>
                            {iv.status !== 'paid' ? (
                              <button
                                onClick={() =>
                                  updateInvoice.mutate({ id: iv.id, patch: { status: 'paid' } })
                                }
                                className="cursor-pointer rounded-md px-1.5 py-1 font-mono text-[10.5px] text-loom-muted-2 hover:text-loom-green-soft"
                              >
                                mark paid
                              </button>
                            ) : null}
                            <button
                              onClick={() => openEdit(iv)}
                              aria-label="Edit invoice"
                              className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-accent-soft"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              onClick={() => deleteInvoice.mutate(iv.id)}
                              aria-label="Delete invoice"
                              className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-red-soft"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
