// Measures where the caret sits inside a <textarea>, in pixels relative to
// the textarea's own border box. Works by mirroring the textarea's text and
// box-relevant computed styles into a hidden div, then reading the offset of
// a marker span inserted at the caret position. Standard technique (see e.g.
// component-kitchen/textarea-caret-position) — no library dependency needed
// for this one measurement.

const MIRRORED_PROPERTIES = [
  'boxSizing',
  'width',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
] as const

let mirrorDiv: HTMLDivElement | null = null

export function getCaretCoordinates(textarea: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  if (!mirrorDiv) {
    mirrorDiv = document.createElement('div')
    document.body.appendChild(mirrorDiv)
  }
  const div = mirrorDiv
  const computed = window.getComputedStyle(textarea)

  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.left = '-9999px'
  div.style.top = '0px'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'

  const style = div.style as unknown as Record<string, string>
  const computedRecord = computed as unknown as Record<string, string>
  for (const prop of MIRRORED_PROPERTIES) {
    style[prop] = computedRecord[prop]
  }

  div.textContent = textarea.value.substring(0, position)
  const span = document.createElement('span')
  span.textContent = textarea.value.substring(position) || '.'
  div.appendChild(span)

  const coordinates = {
    top: span.offsetTop + parseInt(computed.borderTopWidth || '0', 10),
    left: span.offsetLeft + parseInt(computed.borderLeftWidth || '0', 10),
    height: parseInt(computed.lineHeight || '0', 10) || span.offsetHeight,
  }
  div.removeChild(span)
  return coordinates
}
