import { useRef, useState } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Check, CircleHelp, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
import { tourAnchor, TOUR_CHAPTERS, type TourChapter } from './tourAnchors'
import { TOUR_LANG_LABEL, TOUR_LANG_SHORT, tourCopy } from './tourCopy'
import { hasSeenTour, type TourLang } from './tourPrefs'
import { startTour } from './startTour'
import { availableTourChapters } from './tourSteps'
import { useTourActive } from './useTourActive'
import { useTourAutoStart } from './useTourAutoStart'
import { useTourLang } from './useTourLang'

const LANGS: readonly TourLang[] = ['id', 'en']

/** Every chapter offered, until the panel is opened and the DOM is asked. The
 *  panel is closed at that point, so nothing is rendered from this — it exists
 *  only so the first paint after a click has something of the right shape. */
const ALL_AVAILABLE: Record<TourChapter, boolean> = { overview: true, workspace: true, chat: true, ssh: true }

/**
 * The floating "?" button, bottom-right, and the small panel behind it: start
 * any of the guided tours, and pick the language they speak.
 *
 * The panel lists every chapter rather than only the ones that apply here, and
 * greys out the ones whose screen is not open — a reader who cannot start the
 * SSH tour has still learned that it exists and roughly where. Availability is
 * a DOM question (`availableTourChapters`), resolved when the panel opens
 * rather than on a route change: the chat chapter, for one, is offerable from
 * a worktree pane and from the SSH rail alike, and neither is a route.
 *
 * It owns the bottom-right corner permanently, which is why the three
 * transient surfaces that used to live there — ToastHost, TransferStatusPanel
 * and UpdateBanner — are now offset to stack *above* it rather than land on
 * top of it. Each carries a comment pointing back here.
 *
 * Mounted from GlobalOverlays, so it exists on every workspace route and not on
 * login/onboarding, where there is no interface to tour yet.
 */
export function HelpFab() {
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<Record<TourChapter, boolean>>(ALL_AVAILABLE)
  const [lang, setLang] = useTourLang()
  const popupRef = useRef<HTMLDivElement>(null)
  const copy = tourCopy(lang)

  useTourAutoStart()

  // Scoped to the panel's own rect, like every other Base UI popover here.
  useNativeOverlayBlocker(open, popupRef)
  // Viewport-wide for the tour itself: driver.js paints a full-screen backdrop
  // and moves its popover across the whole window, so there is no rect to scope
  // to — and in the desktop shell an open Browser tile is a native webview
  // above the entire DOM, which would otherwise swallow the tour whole.
  useNativeOverlayBlocker(useTourActive())

  function handleOpenChange(next: boolean) {
    // Read on the way open, never on a timer: this is a layout read of the
    // whole document, and the only moment it can be observed is the frame the
    // panel paints in.
    if (next) setAvailable(availableTourChapters())
    setOpen(next)
  }

  function launch(chapter: TourChapter) {
    // The panel sits over the corner the last step highlights, and over the
    // composer the chat chapter walks, so it has to be gone before the overlay
    // comes up.
    setOpen(false)
    void startTour(chapter, lang)
  }

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Trigger
          {...tourAnchor('help-fab')}
          aria-label={copy.chrome.helpLabel}
          title={copy.chrome.helpLabel}
          className={cn(
            'flex h-10 w-10 cursor-pointer items-center justify-center rounded-full',
            'border border-devdeck-border-menu bg-devdeck-glass-solid text-devdeck-fg-2',
            'shadow-[0_10px_26px_rgba(0,0,0,0.42)] transition-colors',
            'hover:border-devdeck-border-accent hover:text-devdeck-accent',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            open && 'border-devdeck-border-accent text-devdeck-accent',
          )}
        >
          <CircleHelp size={18} />
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Positioner side="top" align="end" sideOffset={10} style={{ zIndex: 50 }} className="outline-none">
            <Popover.Popup
              ref={popupRef}
              className={cn(
                'w-[292px] origin-[var(--transform-origin)] rounded-control border border-devdeck-border-menu',
                'bg-devdeck-glass-solid p-3 shadow-[0_12px_28px_rgba(0,0,0,0.48)] outline-none',
                'transition-all duration-150',
                'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
                'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
              )}
            >
              <div className="font-mono text-[9px] font-semibold tracking-[0.14em] text-devdeck-fg-2">
                {copy.chrome.panelTitle.toUpperCase()}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-devdeck-fg-2">{copy.chrome.panelHint}</p>

              <div className="mt-3 border-t border-devdeck-border-strong pt-2.5">
                <div className="mb-1.5 font-mono text-[9px] font-semibold tracking-[0.14em] text-devdeck-fg-2">
                  {copy.chrome.toursLabel.toUpperCase()}
                </div>
                <div className="flex flex-col gap-1">
                  {TOUR_CHAPTERS.map((chapter) => (
                    <ChapterButton
                      key={chapter}
                      chapter={chapter}
                      lang={lang}
                      enabled={available[chapter]}
                      onLaunch={launch}
                    />
                  ))}
                </div>
              </div>

              <div className="mt-3 border-t border-devdeck-border-strong pt-2.5">
                <div className="mb-1.5 font-mono text-[9px] font-semibold tracking-[0.14em] text-devdeck-fg-2">
                  {copy.chrome.languageLabel.toUpperCase()}
                </div>
                {/* Stacked rather than a two-up segmented control: the labels
                    are endonyms ("Bahasa Indonesia"), which a half-width cell
                    truncates to nothing useful. */}
                <div className="flex flex-col gap-1" role="group" aria-label={copy.chrome.languageLabel}>
                  {LANGS.map((option) => {
                    const active = option === lang
                    return (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setLang(option)}
                        className={cn(
                          'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border px-2 text-[12px] font-medium transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                          active
                            ? 'border-devdeck-border-accent bg-devdeck-accent-tint text-devdeck-accent'
                            : 'border-transparent bg-transparent text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
                        )}
                      >
                        <span className="font-mono text-[9.5px] tracking-[0.12em]">{TOUR_LANG_SHORT[option]}</span>
                        <span className="min-w-0 flex-1 truncate text-left">{TOUR_LANG_LABEL[option]}</span>
                        {active ? <Check size={13} className="flex-none" /> : null}
                      </button>
                    )
                  })}
                </div>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}

/** One tour on offer. The accessible name is the chapter's own label — the
 *  start/replay wording is a tooltip, not part of the name, so a screen reader
 *  hears "SSH" rather than "Replay tutorial" four times over. */
function ChapterButton({
  chapter,
  lang,
  enabled,
  onLaunch,
}: {
  chapter: TourChapter
  lang: TourLang
  enabled: boolean
  onLaunch: (chapter: TourChapter) => void
}) {
  const copy = tourCopy(lang)
  const { label, hint } = copy.chapters[chapter]
  // Read per render rather than held in state: `startTour`'s onDestroyed writes
  // the flag, and the `useTourActive` subscription in the parent re-renders
  // this component the moment a tour ends — so "Start" becomes "Replay"
  // without the two ever needing to be kept in sync by hand.
  const seen = hasSeenTour(chapter)

  return (
    <button
      type="button"
      disabled={!enabled}
      title={enabled ? (seen ? copy.chrome.restart : copy.chrome.start) : copy.chrome.unavailable}
      onClick={() => onLaunch(chapter)}
      className={cn(
        'flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        enabled
          ? 'cursor-pointer text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg'
          : 'cursor-default text-devdeck-fg-2 opacity-45',
      )}
    >
      <Play size={12} className="mt-[3px] flex-none" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12px] font-medium">{label}</span>
        <span className="text-[11px] leading-snug text-devdeck-fg-2">{enabled ? hint : copy.chrome.unavailable}</span>
      </span>
    </button>
  )
}
