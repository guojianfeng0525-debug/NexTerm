import { describe, expect, it } from "vitest";
import { postgresCompletionPosition, postgresStaticCompletions } from "@/lib/postgres-completion";

describe("PostgreSQL completion", () => {
  it("offers relation-aware completion after FROM", () => {
    expect(postgresCompletionPosition("SELECT * FROM pub")).toBe("relation");
  });

  it("offers PostgreSQL types after a cast", () => {
    const options = postgresStaticCompletions("SELECT value::");
    expect(options.some((option) => option.label === "jsonb")).toBe(true);
    expect(options.some((option) => option.label === "SELECT")).toBe(false);
  });

  it("does not complete inside comments or strings", () => {
    expect(postgresCompletionPosition("SELECT * -- comment")).toBe("none");
    expect(postgresCompletionPosition("SELECT 'unfinished")).toBe("none");
  });

  it("resets context at statement boundaries", () => {
    expect(postgresCompletionPosition("SELECT 1; SELECT * FROM ")).toBe("relation");
  });
});
