/** Errors from direct adapter calls; Core applies its own port errors. */
export type AdapterErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_REQUEST"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "ABORTED";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly status?: number;

  constructor(code: AdapterErrorCode, message: string, status?: number) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}
