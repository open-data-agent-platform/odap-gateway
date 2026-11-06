export function isAdminPageRequest(pathname: string) {
  // Static asset routing decodes URL escapes; apply the same boundary before it.
  try {
    return /^\/+admin(?:[/.]|$)/.test(decodeURIComponent(pathname));
  } catch {
    return false;
  }
}
