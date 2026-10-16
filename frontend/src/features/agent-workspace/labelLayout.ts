export type LabelRect = {
  id: string
  x: number
  y: number
  width: number
  height: number
  priority: number
}
export function placeLabels(
  labels: LabelRect[],
  width: number,
  height: number,
) {
  const placed: (LabelRect & { visible: boolean })[] = []
  const overlaps = (a: LabelRect, b: LabelRect) =>
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 6 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 + 4
  for (const label of [...labels].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  )) {
    const value = { ...label, visible: true }
    if (label.priority >= 2) {
      value.x = Math.max(
        label.width / 2 + 4,
        Math.min(width - label.width / 2 - 4, label.x),
      )
      value.y = Math.max(
        label.height / 2 + 4,
        Math.min(height - label.height / 2 - 4, label.y),
      )
      for (
        let i = 0;
        i < 6 && placed.some((p) => p.visible && overlaps(value, p));
        i++
      )
        value.y -= label.height + 8
      if (value.y < label.height / 2)
        value.y = Math.min(
          height - label.height / 2,
          label.y + label.height + 8,
        )
    } else if (placed.some((p) => p.visible && overlaps(value, p)))
      value.visible = false
    placed.push(value)
  }
  return placed
}
