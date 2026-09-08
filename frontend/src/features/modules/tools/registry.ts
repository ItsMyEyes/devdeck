import type { ReactElement } from 'react'
import { Archive, Binary, Braces, Clock, FileInput, FileOutput, Hash, KeyRound, Link2, type LucideIcon, Fingerprint } from 'lucide-react'
import { Base64Tool } from './Base64Tool'
import { CompressTool } from './CompressTool'
import { FormatterTool } from './FormatterTool'
import { HashTool } from './HashTool'
import { JwtTool } from './JwtTool'
import { MarkdownExportCard } from './MarkdownExportCard'
import { MarkitdownCard } from './MarkitdownCard'
import { TimestampTool } from './TimestampTool'
import { UrlTool } from './UrlTool'
import { UuidTool } from './UuidTool'

export interface ToolDef {
  id: string
  label: string
  description: string
  category: string
  icon: LucideIcon
  Component: () => ReactElement
}

/** Registry of Tools-module entries. Add new tools here — the sidebar and layout scale automatically. */
export const TOOL_REGISTRY: ToolDef[] = [
  {
    id: 'jwt',
    label: 'JWT Encode / Decode',
    description: 'Inspect, verify, and sign JWTs - HMAC secret or RSA (OpenSSL) key pair',
    category: 'Encoding & Crypto',
    icon: KeyRound,
    Component: JwtTool,
  },
  {
    id: 'base64',
    label: 'Base64',
    description: 'Encode/decode text as Base64 or Base64url',
    category: 'Encoding & Crypto',
    icon: Binary,
    Component: Base64Tool,
  },
  {
    id: 'url',
    label: 'URL Encode / Decode',
    description: 'encodeURIComponent/decodeURIComponent, or full-URI mode',
    category: 'Encoding & Crypto',
    icon: Link2,
    Component: UrlTool,
  },
  {
    id: 'hash',
    label: 'Hash Generator',
    description: 'SHA-1 / SHA-256 / SHA-384 / SHA-512 digests',
    category: 'Encoding & Crypto',
    icon: Hash,
    Component: HashTool,
  },
  {
    id: 'formatter',
    label: 'JSON / XML / CSV',
    description: 'Beautify, validate, and explore structured data',
    category: 'Data',
    icon: Braces,
    Component: FormatterTool,
  },
  {
    id: 'uuid',
    label: 'UUID Generator',
    description: 'Bulk-generate RFC 4122 v4 UUIDs',
    category: 'Generators',
    icon: Fingerprint,
    Component: UuidTool,
  },
  {
    id: 'timestamp',
    label: 'Timestamp Converter',
    description: 'Unix epoch (s/ms) ↔ ISO/UTC/local date-time',
    category: 'Generators',
    icon: Clock,
    Component: TimestampTool,
  },
  {
    id: 'compress',
    label: 'Data Compression',
    description: 'gzip (DEFLATE + CRC32) - checksum-verified lossless compress/decompress',
    category: 'Data',
    icon: Archive,
    Component: CompressTool,
  },
  {
    id: 'doc-to-markdown',
    label: 'Document → Markdown',
    description: 'PDF, Word, PPT, Excel, images, HTML → markdown',
    category: 'Documents',
    icon: FileInput,
    Component: MarkitdownCard,
  },
  {
    id: 'markdown-to-doc',
    label: 'Markdown → Document',
    description: 'Export markdown (+ mermaid diagrams) to Word or PDF',
    category: 'Documents',
    icon: FileOutput,
    Component: MarkdownExportCard,
  },
]
