import { describe, expect, it } from "vitest";
import {
  adaptPostgresQueryResult,
  adaptPostgresTableResult,
} from "@/lib/database/postgresql-result-adapter";
import type { DatabaseTabularResult } from "@/lib/database/result-types";

describe("shared database result contracts", () => {
  it("keeps duplicate labels, NULL, and large numeric strings positional", () => {
    const result = adaptPostgresQueryResult({
      columns: ["id", "id", "amount"],
      rows: [[null, "", "9223372036854775807.123456789"]],
      truncated: false,
    });

    expect(result.kind).toBe("tabular");
    if (result.kind !== "tabular") throw new Error("expected tabular result");
    expect(result.columns.map((column) => column.key)).toEqual([
      "column:0",
      "column:1",
      "column:2",
    ]);
    expect(result.columns.map((column) => column.label)).toEqual(["id", "id", "amount"]);
    expect(result.rows[0]).toEqual([null, "", "9223372036854775807.123456789"]);
    expect(result.editability).toEqual({ editable: false, primaryKeyColumnKeys: [] });
  });

  it("supports semantic and provider-native type identity without requiring it from PostgreSQL IPC", () => {
    const result: DatabaseTabularResult = {
      kind: "tabular",
      columns: [
        {
          key: "column:0",
          label: "total",
          ordinal: 0,
          semanticType: "number",
          providerType: "decimal(38, 9)",
        },
      ],
      rows: [["9223372036854775807.123456789"]],
      commandTags: [],
      truncated: false,
      editability: { editable: false, primaryKeyColumnKeys: [] },
    };

    expect(result.columns[0]).toMatchObject({
      semanticType: "number",
      providerType: "decimal(38, 9)",
    });
  });

  it("maps existing PostgreSQL table paging and primary-key metadata", () => {
    const result = adaptPostgresTableResult(
      {
        columns: ["id", "name"],
        rows: [["8", "Ada"]],
        primaryKeyColumns: ["id"],
        truncated: true,
      },
      { offset: 100, limit: 100 },
    );

    expect(result.pagination).toEqual({ offset: 100, limit: 100, hasMore: true });
    expect(result.editability).toEqual({
      editable: true,
      primaryKeyColumnKeys: ["column:0"],
    });
  });

  it("represents command and empty results without inventing a table", () => {
    expect(
      adaptPostgresQueryResult({
        columns: [],
        rows: [],
        commandTags: ["3"],
        truncated: false,
      }),
    ).toEqual({ kind: "command", commandTags: ["3"] });
    expect(
      adaptPostgresQueryResult({
        columns: [],
        rows: [],
        commandTags: [],
        truncated: false,
      }),
    ).toEqual({ kind: "empty" });
  });
});
