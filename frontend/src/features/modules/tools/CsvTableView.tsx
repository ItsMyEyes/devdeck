/** Renders parsed CSV rows as a scrollable table, treating the first row as the header. */
export function CsvTableView({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows
  if (!header) return null

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-devdeck-border-card bg-devdeck-pane">
      <table className="w-full min-w-max border-collapse text-[11.5px]">
        <thead className="sticky top-0 bg-devdeck-glass-solid">
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="border-b border-devdeck-border-menu px-2.5 py-1.5 text-left font-mono font-medium whitespace-nowrap text-devdeck-fg-2"
              >
                {cell || <span className="text-devdeck-fg-2">col {i + 1}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="border-b border-devdeck-border-card last:border-none hover:bg-white/[0.02]">
              {header.map((_, ci) => (
                <td key={ci} className="px-2.5 py-1.5 whitespace-nowrap text-devdeck-fg-2">
                  {row[ci] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
