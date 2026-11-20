/**
 * Transport or overlay failure of the Mandala `ColorOverlayProvider`
 * (C§2.1, C§6). B7: `@bsv/color-permission-module` no longer exports a
 * provider error class, so the lib owns it. Receivers classify by `.name`,
 * then the `[ColorProviderError] ` prefix, then the `(ERR_…)` code.
 */
export class ColorProviderError extends Error {
  readonly name = 'ColorProviderError'
  constructor (
    /** Overlay verdict code, or 'ERR_UNAVAILABLE' for transport. */
    readonly code: string,
    readonly retryable: boolean,
    /** True: no typed verdict (network, timeout, 5xx, typed ERR_UNAVAILABLE). */
    readonly transport: boolean,
    message: string
  ) {
    super(message.startsWith('[ColorProviderError] ') ? message : `[ColorProviderError] ${message}`)
  }
}
