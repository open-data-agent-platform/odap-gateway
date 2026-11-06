import worker from "../../worker";
import type { AuthProvider } from "../../lib/auth";

export async function startOAuthLogin(env: Parameters<typeof worker.fetch>[1], provider: AuthProvider = "google") {
  const response = await worker.fetch(new Request("https://gateway.test/api/auth/start/"+provider+"?returnTo=%2Fadmin"),env,
    {waitUntil:() => undefined});
  const redirect = new URL(response.headers.get("Location")!);
  const state = redirect.searchParams.get("state");
  if (!state) throw new Error("Synthetic login did not start");
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const url = "https://gateway.test/api/auth/callback/"+provider+"?code=fixture&state="+encodeURIComponent(state);
  return {response,state,cookie,url,request:() => new Request(url,{headers:{Cookie:cookie}})};
}
