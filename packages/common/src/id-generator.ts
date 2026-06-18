let counter = 0;

export function generateId(): string {
  counter++;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateUniqueId(prefix?: string): string {
  return prefix ? `${prefix}-${generateId()}` : generateId();
}
