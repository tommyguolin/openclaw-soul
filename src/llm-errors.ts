/**
 * Patterns that indicate LLM output is actually an error message,
 * not real generated content. Used to filter out responses where the
 * gateway/provider returned an error string rather than a model completion.
 */
export const LLM_ERROR_PATTERNS: RegExp[] = [
  /request timed out before a response was generated/i,
  /timed out before a response/i,
  /overloaded.*try again/i,
  /rate limit exceeded/i,
  /too many requests/i,
  /service temporarily unavailable/i,
  /internal server error/i,
  /server error/i,
  /connection.*timed? ?out/i,
  /failed to generate/i,
  /please try again.*increase.*timeout/i,
  /increase `?agents\.defaults\.timeoutSeconds`?/i,
  /529/i, // MiniMax overloaded
];

/** Check if text looks like an LLM error message rather than real content. */
export function isLLMErrorContent(text: string): boolean {
  if (!text) return false;
  return LLM_ERROR_PATTERNS.some((p) => p.test(text));
}
