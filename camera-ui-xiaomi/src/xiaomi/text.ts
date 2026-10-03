/** The text, or undefined when it is missing or blank: Xiaomi sends empty strings for values it does not have. */
export function nonEmpty(text: string | null | undefined): string | undefined {
  return text?.trim() ? text : undefined;
}

/**
 * An error with what caused it, for the log: fetch says only "fetch failed" and keeps what happened (a name that does
 * not resolve, a refused connection) in `cause`. The query of an address in it is cut off: it can carry keys or tokens.
 */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    let text: string;
    let next: unknown;
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      text = current.message || (typeof code === 'string' ? code : current.name);
      // a connection tried on several addresses fails with all of them, the first one says enough
      next = current instanceof AggregateError && current.cause === undefined ? current.errors[0] : current.cause;
    } else {
      text = typeof current === 'string' ? current : JSON.stringify(current);
    }
    if (text && !parts.includes(text)) parts.push(text);
    current = next;
  }
  return parts.join(': ').replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/gi, '$1?...');
}
