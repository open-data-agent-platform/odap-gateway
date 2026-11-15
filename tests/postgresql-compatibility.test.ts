import { expect, it } from "vitest";
import { POSTGRES_SERVER_VERSIONS, postgresServerVersion } from "../integrations/postgresql/compatibility";

it.each([["150020", "15.20"], ["160016", "16.16"], ["170012", "17.12"], ["180007", "18.7"]])(
  "recognizes only the exact server build %s as %s", (number, label) => {
    expect(postgresServerVersion(number)).toBe(label);
  });
it.each([undefined, null, 170012, {}, [], "17.12", "170011", "170013", "180006", "140025",
  "190000", " 170012", "170012\n", "constructor", "__proto__"])("refuses an unverified version representation (%j)", value => {
  expect(postgresServerVersion(value)).toBeNull();
});
it("does not permit a caller to broaden the verified server registry", () => {
  expect(Object.isFrozen(POSTGRES_SERVER_VERSIONS)).toBe(true);
  expect(Reflect.set(POSTGRES_SERVER_VERSIONS, "190000", "19rc2")).toBe(false);
  expect(postgresServerVersion("190000")).toBeNull();
});
