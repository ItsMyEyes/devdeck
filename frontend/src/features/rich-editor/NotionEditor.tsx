import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { cn } from '@/lib/utils'
import { BlockControls } from './BlockControls'
import { BubbleToolbar } from './BubbleToolbar'
import { createEditorExtensions } from './extensions'
import { stripTrailingNewlines } from './markdownFile'
import { looksLikeMarkdown } from './markdownPaste'

export interface NotionEditorHandle {
  /** Splices markdown in at the caret. The attachment-upload path needs this:
   *  its `onSuccess` lands long after the render that started the upload, so
   *  it can't go through `value`/`onChange` without clobbering whatever was
   *  typed in the meantime. Deliberately does not focus — by the time a slow
   *  upload resolves the user may well be somewhere else on the page. */
  insertMarkdown: (markdown: string) => void
  focus: () => void
  isFocused: () => boolean
}

export interface NotionEditorProps {
  /** Markdown in, markdown out — the editor's whole I/O surface. */
  value: string
  onChange: (value: string) => void
  /** True once `value` is the real, loaded content. Until then the editor
   *  stays empty rather than parsing a placeholder empty string and reporting
   *  it back as an edit. Defaults to `true` for callers with no async load. */
  ready?: boolean
  /** Shown on an empty document. Read through a getter internally, so
   *  changing it does not tear down the editor. */
  placeholder?: string
  editable?: boolean
  autoFocus?: boolean
  ariaLabel?: string
  /** Wrapper class — layout and scrolling belong to the caller. */
  className?: string
  /** Class on the ProseMirror surface itself: padding, max-width, min-height. */
  contentClassName?: string
  onBlur?: () => void
  /** A pasted or dropped file. Return true to claim it (the editor then
   *  suppresses its own handling); callers without upload support omit it. */
  onFile?: (file: File) => boolean
  /** Notion's hover gutter (`+` and drag handle). Off by default: it lives in
   *  ~52px of space to the LEFT of the text, which only a page-width surface
   *  has — a field on a form would draw it over the form. */
  blockControls?: boolean
  /** Hands the editor instance out as it is created and destroyed, for chrome
   *  the caller owns rather than the editor (the outline rail, which has to be
   *  positioned against the caller's scroll container). A callback rather than
   *  a ref because the caller needs to re-render when it arrives. */
  onEditorReady?: (editor: Editor | null) => void
}

function firstFile(list: FileList | null | undefined): File | undefined {
  return list && list.length > 0 ? list[0] : undefined
}

/**
 * The Notion-style WYSIWYG editor behind every markdown surface in DevDeck.
 *
 * Controlled the only way a ProseMirror document can be: the editor owns the
 * document, and `value` is pushed in only when it differs from the markdown
 * this component last emitted. Without that identity check every keystroke
 * would round-trip through the parent and reset the document — and with it the
 * caret and the undo stack.
 *
 * The consequence worth knowing: `getMarkdown()` re-serializes the *whole*
 * document, so editing one line of a file written with `*` bullets rewrites
 * them all as `-`. That is inherent to WYSIWYG markdown; surfaces that hold
 * real files (MarkdownFileEditor) offer a raw Monaco mode as the escape hatch.
 */
export const NotionEditor = forwardRef<NotionEditorHandle, NotionEditorProps>(function NotionEditor(
  {
    value,
    onChange,
    ready = true,
    placeholder,
    editable = true,
    autoFocus = false,
    ariaLabel,
    className,
    contentClassName,
    onBlur,
    onFile,
    blockControls = false,
    onEditorReady,
  },
  ref,
) {
  // The editor is built once (empty dep list): recreating it would drop the
  // document, the caret and the undo history. Everything that can change
  // between renders is therefore read through a ref at call time.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onBlurRef = useRef(onBlur)
  onBlurRef.current = onBlur
  const onFileRef = useRef(onFile)
  onFileRef.current = onFile
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder
  const readyRef = useRef(ready)
  readyRef.current = ready
  const onEditorReadyRef = useRef(onEditorReady)
  onEditorReadyRef.current = onEditorReady
  /** The editor, reachable from the handlers baked into its own options. */
  const editorRef = useRef<Editor | null>(null)
  /** The positioning context BlockControls measures its gutter against. */
  const wrapperRef = useRef<HTMLDivElement>(null)

  const initial = useRef({ ready, value })
  /** The markdown this component last put in or took out of the editor.
   *  `null` until the first real content lands. */
  const lastMarkdown = useRef<string | null>(initial.current.ready ? initial.current.value : null)

  const editor = useEditor(
    {
      extensions: createEditorExtensions({ placeholder: () => placeholderRef.current }),
      content: initial.current.ready ? initial.current.value : '',
      contentType: 'markdown',
      editable,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          // `.notion-doc` is the whole theme (see globals.css). Tiptap's own
          // `.tiptap`/`.ProseMirror` classes land here too, but nothing styles
          // them — the theme is one explicit class so it can't leak into the
          // agent chat's markdown, which has its own.
          class: cn('notion-doc', contentClassName),
          ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        },
        handlePaste: (view, event) => {
          const file = Array.from(event.clipboardData?.items ?? [])
            .find((item) => item.kind === 'file')
            ?.getAsFile()
          if (file) return onFileRef.current?.(file) ?? false

          // Agents and terminals hand out markdown as plain text. Pasting it
          // verbatim into a WYSIWYG canvas would leave `## Heading` sitting
          // there as literal characters, so parse it instead — but only when
          // the clipboard has no richer flavor to defer to, and never inside
          // a fence, where the syntax is the point.
          const text = event.clipboardData?.getData('text/plain')
          const html = event.clipboardData?.getData('text/html')
          if (!text || html) return false
          if (view.state.selection.$from.parent.type.spec.code) return false
          if (!looksLikeMarkdown(text)) return false
          editorRef.current?.chain().focus().insertContent(text, { contentType: 'markdown' }).run()
          return true
        },
        handleDrop: (_view, event) => {
          const file = firstFile((event as DragEvent).dataTransfer?.files)
          return file ? (onFileRef.current?.(file) ?? false) : false
        },
      },
      onUpdate({ editor: instance }) {
        // Anything typed before the real content arrives is about to be
        // replaced by it — reporting it would mark an untouched file dirty.
        if (!readyRef.current) return
        const markdown = instance.getMarkdown()
        lastMarkdown.current = markdown
        onChangeRef.current(markdown)
      },
      onBlur() {
        onBlurRef.current?.()
      },
    },
    [],
  )
  editorRef.current = editor

  useImperativeHandle(ref, () => ({
    insertMarkdown: (markdown) => {
      editor?.commands.insertContent(markdown, { contentType: 'markdown' })
    },
    focus: () => editor?.commands.focus('end'),
    isFocused: () => editor?.isFocused ?? false,
  }))

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    onEditorReadyRef.current?.(editor ?? null)
    return () => onEditorReadyRef.current?.(null)
  }, [editor])

  // Pushes external changes in — the file finishing its load, a revert, the
  // raw-markdown pane handing the buffer back. `emitUpdate: false` keeps this
  // from bouncing straight back out through `onUpdate`.
  //
  // The comparison ignores trailing newlines because neither side controls
  // them: a document ending in blank lines serializes with them, while a
  // caller that owns a file re-attaches its own (MarkdownFileEditor keeps the
  // file's final newline). Treating that as an external change would reset the
  // document mid-keystroke. Nothing is lost — trailing blank lines are
  // invisible on a WYSIWYG canvas.
  useEffect(() => {
    if (!editor || !ready) return
    const last = lastMarkdown.current
    if (last !== null && stripTrailingNewlines(value) === stripTrailingNewlines(last)) return
    lastMarkdown.current = value
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [editor, ready, value])

  return (
    <div ref={wrapperRef} className={cn('relative min-w-0', className)}>
      {editor && editable ? <BubbleToolbar editor={editor} /> : null}
      {editor && editable && blockControls ? (
        <BlockControls editor={editor} wrapperRef={wrapperRef} />
      ) : null}
      <EditorContent editor={editor} className="min-w-0" />
    </div>
  )
})
