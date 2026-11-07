import { describe, expect, it } from "vitest";
import robots from "../app/robots";

describe("Gateway crawler policy", () => {
  it("allows crawling without using robots as access control", () => {
    expect(robots()).toEqual({ rules: { userAgent: "*", allow: "/" } });
  });
});
