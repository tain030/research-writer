export type ExternalSyncProvider =
  | "Dropbox"
  | "OneDrive"
  | "Google Drive"
  | "iCloud";

export function externalSyncProvider(
  path: string,
): ExternalSyncProvider | null {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (/(?:^|\/)dropbox(?:\/|$)/u.test(normalized)) return "Dropbox";
  if (/(?:^|\/)onedrive(?: - [^/]+)?(?:\/|$)/u.test(normalized)) {
    return "OneDrive";
  }
  if (
    normalized.includes("/google drive/") ||
    normalized.includes("/googledrive-")
  ) {
    return "Google Drive";
  }
  if (normalized.includes("/mobile documents/com~apple~clouddocs/")) {
    return "iCloud";
  }
  return null;
}
