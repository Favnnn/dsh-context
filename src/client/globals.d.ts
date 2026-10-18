/** Runtime globals of the browser bundle's CJS closure, declared for the strict typecheck. */

declare function require(id: string): unknown
declare let module: { exports: Record<string, unknown> }
declare let exports: Record<string, unknown>

// Stylesheet channels (see tsdown.config.ts): side-effect global sheets, ?inline text, CSS Modules maps.
declare module '*.css'
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.svg?raw' {
  const markup: string
  export default markup
}
