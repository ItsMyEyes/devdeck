import { useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InfoTooltip } from '@/components/ui/tooltip'
import { fmtRupiah } from '@/lib/format'
import type { RecurringInvoiceTemplate } from '@/store/types'
import {
  useCreateBank,
  useCreateCompany,
  useCreateRecurringTemplate,
  useDeleteRecurringTemplate,
  useUpdateRecurringTemplate,
} from '@/features/data/queries'
import { BankPicker } from '../BankPicker'
import { CompanyPicker } from '../CompanyPicker'

interface DraftItem {
  description: string
  quantity: string
  unitPrice: string
}

interface Draft {
  editId: string | null
  companyName: string
  companyAddress: string
  items: DraftItem[]
  bankName: string
  bankAccountName: string
  bankAccountNumber: string
  dayOfMonth: string
  paymentTermDays: string
}

function emptyItem(): DraftItem {
  return { description: '', quantity: '1', unitPrice: '' }
}

function itemTotal(it: DraftItem): number {
  return (parseFloat(it.quantity) || 0) * (parseFloat(it.unitPrice.replace(/[^0-9.]/g, '')) || 0)
}

function fmtShortDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Next auto-generation date, and the estimated due date (next run + payment term). */
function nextRunInfo(tpl: RecurringInvoiceTemplate): { nextRun: Date; due: Date } {
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const day = Math.min(tpl.dayOfMonth, daysInMonth)
  const generatedThisMonth = tpl.lastGeneratedYm === ym
  const nextRun = new Date(now.getFullYear(), now.getMonth() + (generatedThisMonth ? 1 : 0), day)
  const due = new Date(nextRun)
  due.setDate(due.getDate() + tpl.paymentTermDays)
  return { nextRun, due }
}

/** Recurring invoice templates: create/edit/delete monthly billing schedules. */
export function RecurringTab({ wsId, templates }: { wsId: string; templates: RecurringInvoiceTemplate[] }) {
  const createTemplate = useCreateRecurringTemplate()
  const updateTemplate = useUpdateRecurringTemplate()
  const deleteTemplate = useDeleteRecurringTemplate()
  const createCompany = useCreateCompany()
  const createBank = useCreateBank()

  const [draft, setDraft] = useState<Draft | null>(null)

  function openNew() {
    setDraft({
      editId: null,
      companyName: '',
      companyAddress: '',
      items: [emptyItem()],
      bankName: '',
      bankAccountName: '',
      bankAccountNumber: '',
      dayOfMonth: '1',
      paymentTermDays: '14',
    })
  }

  function openEdit(tpl: RecurringInvoiceTemplate) {
    setDraft({
      editId: tpl.id,
      companyName: tpl.companyName,
      companyAddress: tpl.companyAddress,
      items: tpl.items.length
        ? tpl.items.map((it) => ({ description: it.description, quantity: String(it.quantity), unitPrice: String(it.unitPrice) }))
        : [emptyItem()],
      bankName: tpl.bankDetail.bankName,
      bankAccountName: tpl.bankDetail.accountName,
      bankAccountNumber: tpl.bankDetail.accountNumber,
      dayOfMonth: String(tpl.dayOfMonth),
      paymentTermDays: String(tpl.paymentTermDays),
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
    const dayOfMonth = Math.min(28, Math.max(1, parseInt(draft.dayOfMonth, 10) || 1))
    const paymentTermDays = Math.max(0, parseInt(draft.paymentTermDays, 10) || 0)
    const body = {
      companyName: draft.companyName.trim() || 'Untitled client',
      companyAddress: draft.companyAddress.trim(),
      items,
      bankName,
      bankAccountName,
      bankAccountNumber,
      dayOfMonth,
      paymentTermDays,
    }
    if (draft.editId) {
      updateTemplate.mutate({ id: draft.editId, patch: body }, { onSuccess: () => setDraft(null) })
    } else {
      createTemplate.mutate({ wsId, body }, { onSuccess: () => setDraft(null) })
    }
  }

  const saving = createTemplate.isPending || updateTemplate.isPending
  const draftGrandTotal = draft ? draft.items.reduce((sum, it) => sum + itemTotal(it), 0) : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between border-b border-loom-border px-4 py-2.5">
        <span className="font-mono text-[11px] text-loom-dim">
          Auto-generates a draft invoice on the scheduled day each month.
        </span>
        <Button size="sm" onClick={openNew}>
          <Plus size={13} />
          New template
        </Button>
      </div>

      {draft ? (
        <div className="flex-none border-b border-loom-border bg-loom-card/40 px-4 py-3">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="font-mono text-[11.5px] text-loom-muted-2">
              {draft.editId ? 'Edit template' : 'New template'}
            </span>
            <button onClick={() => setDraft(null)} aria-label="Close" className="cursor-pointer p-0.5 text-loom-muted-2 hover:text-loom-fg">
              <X size={14} />
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1 font-mono text-[10px] text-loom-dim">
                Day of month
                <InfoTooltip text="The day each month a new draft invoice is generated for this template. If a month is shorter than this day (e.g. February), it generates on that month's last day instead." />
              </span>
              <Input
                type="number"
                min={1}
                max={28}
                value={draft.dayOfMonth}
                onChange={(e) => setDraft({ ...draft, dayOfMonth: e.target.value })}
                className="w-[100px]"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-1 font-mono text-[10px] text-loom-dim">
                Due N days after generation
                <InfoTooltip text="How many days after the invoice is generated it becomes due. For example, 14 means the due date is 14 days after the invoice date." />
              </span>
              <Input
                type="number"
                min={0}
                value={draft.paymentTermDays}
                onChange={(e) => setDraft({ ...draft, paymentTermDays: e.target.value })}
                className="w-[140px]"
              />
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
              <Input value={draft.bankName} onChange={(e) => setDraft({ ...draft, bankName: e.target.value })} placeholder="BCA" className="w-[140px]" />
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
              onPick={(b) => setDraft({ ...draft, bankName: b.bankName, bankAccountName: b.accountName, bankAccountNumber: b.accountNumber })}
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
                        <Input value={it.description} onChange={(e) => updateItem(i, { description: e.target.value })} placeholder="Backend API development" />
                      </td>
                      <td className="py-1 pr-1">
                        <Input value={it.quantity} onChange={(e) => updateItem(i, { quantity: e.target.value })} className="text-right" />
                      </td>
                      <td className="py-1 pr-1">
                        <Input value={it.unitPrice} onChange={(e) => updateItem(i, { unitPrice: e.target.value })} placeholder="0" className="text-right" />
                      </td>
                      <td className="py-1 text-right font-mono text-loom-fg">{fmtRupiah(itemTotal(it))}</td>
                      <td className="py-1 text-right">
                        <button onClick={() => removeItem(i)} aria-label="Remove line item" className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-red-soft">
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1.5 flex items-center justify-between">
                <button onClick={addItem} className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-loom-accent-soft hover:underline">
                  <Plus size={12} />
                  Add line item
                </button>
                <span className="font-mono text-[12.5px] text-loom-fg">Grand total: {fmtRupiah(draftGrandTotal)}</span>
              </div>
            </div>

            <Button size="lg" disabled={saving} onClick={save}>
              {draft.editId ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      ) : null}

      {templates.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center font-mono text-[12px] text-loom-dim">
          No recurring templates yet. Create one to auto-generate a draft invoice every month.
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-loom-border text-left font-mono text-[10px] tracking-wide text-loom-dim uppercase">
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">
                  <span className="flex items-center gap-1">
                    Schedule
                    <InfoTooltip text="Day of month the draft invoice is generated, and how many days after that it becomes due (net terms)." />
                  </span>
                </th>
                <th className="px-3 py-2 font-medium">
                  <span className="flex items-center gap-1">
                    Next run
                    <InfoTooltip text="The next date this template will auto-generate a draft invoice, and the estimated due date (next run + net terms). Skips to the current month if this month's invoice was already generated." />
                  </span>
                </th>
                <th className="px-3 py-2 text-right font-medium">Monthly total</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {templates.map((tpl) => {
                const total = tpl.items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0)
                const { nextRun, due } = nextRunInfo(tpl)
                return (
                  <tr key={tpl.id} className="border-b border-loom-border-card last:border-none hover:bg-loom-card/50">
                    <td className="max-w-[160px] truncate px-3 py-2.5 text-loom-fg">{tpl.companyName || '—'}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap text-loom-dim">
                      Day {tpl.dayOfMonth}, net {tpl.paymentTermDays}d
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap text-loom-dim">
                      <div className="text-loom-fg-2">{fmtShortDate(nextRun)}</div>
                      <div className="text-loom-dim">Due {fmtShortDate(due)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[12px] whitespace-nowrap text-loom-fg">{fmtRupiah(total)}</td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => updateTemplate.mutate({ id: tpl.id, patch: { active: !tpl.active } })}
                        className={`cursor-pointer rounded-md px-2 py-1 font-mono text-[10.5px] ${
                          tpl.active ? 'bg-loom-green-tint text-loom-green-soft' : 'bg-loom-card text-loom-muted-2'
                        }`}
                      >
                        {tpl.active ? 'Active' : 'Paused'}
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        <button onClick={() => openEdit(tpl)} aria-label="Edit template" className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-accent-soft">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => deleteTemplate.mutate(tpl.id)} aria-label="Delete template" className="cursor-pointer p-1 text-loom-muted-2 hover:text-loom-red-soft">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
