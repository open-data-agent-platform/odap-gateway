import { readBoundedProviderJson, withProviderDeadline } from "./provider-response";

const failure = () => new Error("OAuth provider request failed");

export async function fetchOAuthJson(url: string, init: Omit<RequestInit, "signal" | "redirect">): Promise<unknown> {
  try {
    return await withProviderDeadline(async signal => {
      // Fixed provider callers supply the URL. Never redirect credentials elsewhere.
      const response = await fetch(url, { ...init, redirect: "manual", signal });
      if (signal.aborted || !response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      return readBoundedProviderJson(response, signal);
    }, "OAuth provider request failed");
  } catch {
    throw failure();
  }
}
