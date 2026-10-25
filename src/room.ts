/**
 * A device's room slug.
 *
 * Lowercase, non-alphanumerics collapsed to single hyphens, trimmed - and
 * the first eight characters of the id when a name leaves nothing behind.
 * Perception derives the same slug from the same rule for any hub too old
 * to send one, so the two must stay identical.
 */
export function roomOf(device: { name?: string; id?: string }): string {
  const slug = (device.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || (device.id ?? "").slice(0, 8);
}
