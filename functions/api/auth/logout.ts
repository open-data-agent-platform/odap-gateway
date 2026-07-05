import { clearSessionCookie } from "../../../lib/auth";

type LogoutContext = {
  request: Request;
};

export function onRequestGet(context: LogoutContext) {
  const url = new URL(context.request.url);
  const destination = new URL("/login", url.origin);
  destination.searchParams.set("logout", "1");

  return redirectWithClearedSession(destination);
}

export function onRequestPost(context: LogoutContext) {
  const url = new URL(context.request.url);
  const destination = new URL("/", url.origin);
  destination.searchParams.set("logout", "1");

  return redirectWithClearedSession(destination);
}

function redirectWithClearedSession(destination: URL) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: destination.toString(),
      "Set-Cookie": clearSessionCookie(destination.protocol === "https:")
    }
  });
}
