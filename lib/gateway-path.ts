export function normalizeGatewayBasePath(value: string | undefined) {
  if (!value) return "";
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value)) {
    throw new Error("Invalid Gateway base path");
  }
  return value;
}

export function gatewayPath(path: string, base = process.env.NEXT_PUBLIC_GATEWAY_BASE_PATH) {
  const prefix = normalizeGatewayBasePath(base);
  return prefix + (prefix && path === "/" ? "" : path);
}

export function internalGatewayPath(pathname: string, base: string | undefined): string | null {
  const prefix = normalizeGatewayBasePath(base);
  if (!prefix) return pathname;
  if (pathname === prefix) return "/";
  return pathname.startsWith(prefix + "/") ? pathname.slice(prefix.length) : null;
}
