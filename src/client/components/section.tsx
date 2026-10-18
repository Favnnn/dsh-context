/** The Context browser's titled card head, shared by the tool/detail cards and the attachment block. */

import type { ReactElement, ReactNode } from 'react'

export function Section(props: {
  label: string
  labelClass?: string
  /** Fold the head's trailing group onto a second line under width pressure (rich-text heads; the call-name head must stay one-line). */
  foldHead?: boolean
  count?: number
  actions?: ReactNode
  meta?: ReactNode
  children: ReactNode
}): ReactElement {
  const right = props.actions !== undefined || props.meta !== undefined
  return (
    <div className="lc-ts-card">
      <div className={'lc-ts-card-head' + (props.foldHead === true ? ' lc-ts-card-head-wrap' : '')}>
        <b className={props.labelClass} title={props.label}>{props.label}</b>
        {right ? <span className="lc-ts-card-right">{props.meta}{props.actions}</span> : null}
        {props.count !== undefined ? <span className="lc-ts-card-count">{props.count}</span> : null}
      </div>
      {props.children}
    </div>
  )
}
