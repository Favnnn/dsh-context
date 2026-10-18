/** Named imports from the ui-primitives platform module, resolved defensively: an absent or renamed
 * export would render as React error #130 inside the Context tab, so each component resolves by name
 * through a bounded read and degrades to a render-nothing fallback. */

import type { ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

export type IconComponent = (props: IconProps) => ReactElement | null

const ns = primitives as unknown as Record<string, unknown>

/** One export's raw value: undefined when the name is absent or the namespace read throws. */
function exportOf(name: string, source: Record<string, unknown>): unknown {
  try {
    return source[name]
  } catch {
    return undefined
  }
}

/** Resolve one icon by export name; a missing, non-component, or hostile-namespace read renders nothing. */
export function resolveIcon(name: string, source: Record<string, unknown> = ns): IconComponent {
  const found = exportOf(name, source)
  return typeof found === 'function' ? found as IconComponent : () => null
}

export const IconBranch = resolveIcon('IconBranchOutlineRegular')
export const IconPlus = resolveIcon('IconPlusOutlineRegular')
export const IconCheck = resolveIcon('IconCheckOutlineRegular')
export const IconCopy = resolveIcon('IconCopyOutlineRegular')
export const IconClose = resolveIcon('IconCloseOutlineRegular')
export const IconSettings = resolveIcon('IconSettingsOutlineMedium')
export const IconChevronDown = resolveIcon('IconChevronDownOutlineMedium')
export const IconChevronUp = resolveIcon('IconChevronUpOutlineMedium')
export const IconSearch = resolveIcon('IconSearchOutlineRegular')

/** The harness's file-type glyph: its props are its own (`path`/`kind`), not an icon's. */
export interface FileGlyphProps {
  path?: string
  kind?: string
  size?: number
  className?: string
}

export type FileGlyphComponent = (props: FileGlyphProps) => ReactElement | null

/** Resolve the file-type glyph the defensive way the icons resolve. */
export function resolveFileGlyph(source: Record<string, unknown> = ns): FileGlyphComponent {
  const found = exportOf('FileTypeIcon', source)
  return typeof found === 'function' ? found as FileGlyphComponent : () => null
}

export const FileTypeGlyph = resolveFileGlyph()
