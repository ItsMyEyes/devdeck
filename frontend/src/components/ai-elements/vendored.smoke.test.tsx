/**
 * Guards the vendored surface. These are copy-in files, not an npm package —
 * a re-vendor that renames or drops an export breaks the chat pane at build
 * time with no upstream version bump to blame. Asserting the exports exist
 * (not how they render) keeps this cheap and stable.
 */
import { describe, expect, it } from 'vitest'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Tool, ToolContent, ToolHeader, ToolInput } from '@/components/ai-elements/tool'
import { Task, TaskContent, TaskTrigger } from '@/components/ai-elements/task'
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from '@/components/ai-elements/prompt-input'
import { CodeBlock, CodeBlockCopyButton } from '@/components/ai-elements/code-block'

describe('vendored AI Elements surface', () => {
  it.each([
    ['Conversation', Conversation],
    ['ConversationContent', ConversationContent],
    ['ConversationEmptyState', ConversationEmptyState],
    ['ConversationScrollButton', ConversationScrollButton],
    ['Message', Message],
    ['MessageContent', MessageContent],
    ['MessageResponse', MessageResponse],
    ['Reasoning', Reasoning],
    ['ReasoningTrigger', ReasoningTrigger],
    ['ReasoningContent', ReasoningContent],
    ['Tool', Tool],
    ['ToolHeader', ToolHeader],
    ['ToolContent', ToolContent],
    ['ToolInput', ToolInput],
    ['Task', Task],
    ['TaskTrigger', TaskTrigger],
    ['TaskContent', TaskContent],
    ['PromptInput', PromptInput],
    ['PromptInputBody', PromptInputBody],
    ['PromptInputTextarea', PromptInputTextarea],
    ['PromptInputFooter', PromptInputFooter],
    ['PromptInputTools', PromptInputTools],
    ['PromptInputSubmit', PromptInputSubmit],
    ['CodeBlock', CodeBlock],
    ['CodeBlockCopyButton', CodeBlockCopyButton],
  ])('exports %s as a component', (_name, component) => {
    expect(component).toBeDefined()
  })
})
