import { Select } from '@/components/ui/select'
import { useCompanies } from '@/features/data/queries'

interface CompanyPickerProps {
  onPick: (company: { name: string; shortAddress: string }) => void
}

/** Loads company name + short address from a saved preset into the invoice form. */
export function CompanyPicker({ onPick }: CompanyPickerProps) {
  const { data: companies = [] } = useCompanies()
  const options = [
    { value: '', label: 'Load preset…' },
    ...companies.map((c) => ({ value: c.id, label: c.name })),
  ]

  return (
    <div className="w-[160px]">
      <Select
        value=""
        onValueChange={(id) => {
          if (!id) return
          const c = companies.find((c) => c.id === id)
          if (c) onPick({ name: c.name, shortAddress: c.shortAddress })
        }}
        options={options}
        aria-label="Load company preset"
      />
    </div>
  )
}
