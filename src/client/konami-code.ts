export const KONAMI_SEQUENCE = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a"
] as const;

export function normalizeKonamiKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function matchesKonami(buffer: string[]): boolean {
  if (buffer.length < KONAMI_SEQUENCE.length) {
    return false;
  }
  const tail = buffer.slice(buffer.length - KONAMI_SEQUENCE.length);
  return KONAMI_SEQUENCE.every((key, index) => tail[index] === key);
}
