/** Renders parsed CSV rows as a scrollable table, treating the first row as the header. */
export function CsvTableView({ rows }: { rows: string[][] }) {
  const [header, ...body] = rows
  if (!header) return null

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-loom-border-card bg-loom-terminal">
      <table className="w-full min-w-max border-collapse text-[11.5px]">
        <thead className="sticky top-0 bg-loom-popover">
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="border-b border-loom-border-menu px-2.5 py-1.5 text-left font-mono font-medium whitespace-nowrap text-loom-fg-2"
              >
                {cell || <span className="text-loom-dim-2">col {i + 1}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} className="border-b border-loom-border-card last:border-none hover:bg-white/[0.02]">
              {header.map((_, ci) => (
                <td key={ci} className="px-2.5 py-1.5 whitespace-nowrap text-loom-muted">
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
