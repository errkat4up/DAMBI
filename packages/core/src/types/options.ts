export interface CallOptions {
  /** Propagated to external ports; late results after cancellation are ignored. */
  readonly signal?: AbortSignal;
}
