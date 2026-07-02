import { Select } from '@/components/ui/select'
import { useBanks } from '@/features/data/queries'

interface BankPickerProps {
  onPick: (bank: { bankName: string; accountName: string; accountNumber: string }) => void
}

/** Loads bank-detail values from a saved preset into the invoice form. */
export function BankPicker({ onPick }: BankPickerProps) {
  const { data: banks = [] } = useBanks()
  const options = [
    { value: '', label: 'Load preset…' },
    ...banks.map((b) => ({ value: b.id, label: `${b.bankName} — ${b.accountNumber}` })),
  ]

  return (
    <div className="w-[200px]">
      <Select
        value=""
        onValueChange={(id) => {
          if (!id) return
          const b = banks.find((b) => b.id === id)
          if (b) onPick({ bankName: b.bankName, accountName: b.accountName, accountNumber: b.accountNumber })
        }}
        options={options}
        aria-label="Load bank preset"
      />
    </div>
  )
}
