/** Compile-time exhaustiveness check for discriminated unions. */
export function assertNever(value: never, context = 'unhandled case'): never {
  throw new Error(`${context}: ${String(value)}`);
}
