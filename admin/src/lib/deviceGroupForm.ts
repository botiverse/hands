export function deviceGroupUpdatePayload(name: string, description: string) {
  return {
    name: name.trim(),
    description: description.trim() || null,
  };
}
