export interface SourceResolvedAddress {
  address: string;
  id_suffix?: string;
  context?: Record<string, unknown>;
}

export function lookupSourcePath(context: Record<string, unknown>, path: string): unknown;
export function substituteSourcePlaceholders(value: unknown, context: Record<string, unknown>): unknown;
export function sanitizeIdSuffix(value: string): string;
export function appendIdSuffix(id: string, suffix: string): string;
export function buildSourceContext(chainId: number, entry: SourceResolvedAddress): Record<string, unknown>;
export function buildMaterializedFromSource(
  bundle: Record<string, unknown>,
  sourced: { selector: string },
  chainId: number,
  entry: SourceResolvedAddress,
): Record<string, unknown>;
export function materializeSelectedDecoder(template: unknown, contextDoc: unknown): Record<string, unknown>;
