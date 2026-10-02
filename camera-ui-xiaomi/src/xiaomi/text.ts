/** The text, or undefined when it is missing or blank: Xiaomi sends empty strings for values it does not have. */
export function nonEmpty(text: string | null | undefined): string | undefined {
  return text?.trim() ? text : undefined;
}
