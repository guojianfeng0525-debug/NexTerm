/**
 * B23 Table Designer — diff function unit tests.
 *
 * Covers the architecture D-B23-4 rules via property-based + targeted cases.
 * Property-based coverage uses fast-check to fuzz the column/PK sets.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  diffTableDesign,
  draftFromDesign,
  isChangeEmpty,
  type TableDesign,
  type TableDesignDraft,
} from "./table-design";

function baseDesign(): TableDesign {
  return {
    schema: "public",
    table: "t",
    columns: [
      {
        name: "id",
        dataType: "integer",
        nullable: false,
        default: "nextval('t_id_seq')",
        comment: "primary",
        ordinal: 1,
      },
      {
        name: "name",
        dataType: "text",
        nullable: false,
        default: null,
        comment: null,
        ordinal: 2,
      },
      {
        name: "score",
        dataType: "numeric",
        nullable: true,
        default: "0",
        comment: "scoring field",
        ordinal: 3,
      },
    ],
    primaryKey: { name: "t_pkey", columns: ["id"] },
    constraints: [
      {
        name: "t_pkey",
        type: "p",
        definition: "PRIMARY KEY (id)",
        columns: ["id"],
        deferrable: false,
      },
      {
        name: "t_score_check",
        type: "c",
        definition: "CHECK (score >= 0)",
        columns: [],
        deferrable: false,
      },
    ],
    indexes: [
      {
        name: "t_name_idx",
        unique: false,
        method: "btree",
        columns: [{ name: "name", desc: false, nullsFirst: false }],
        definition: "CREATE INDEX t_name_idx ON public.t USING btree (name)",
      },
    ],
    foreignKeys: [
      {
        name: "t_name_fk",
        columns: ["name"],
        references: { schema: "public", table: "names", columns: ["value"] },
        onDelete: "CASCADE",
        onUpdate: null,
        deferrable: false,
      },
    ],
    comment: "baseline table",
    hasData: false,
  };
}

function draftFromBaseline(): TableDesignDraft {
  return draftFromDesign(baseDesign());
}

describe("diffTableDesign", () => {
  it("returns an empty change set when draft mirrors the baseline", () => {
    const draft = draftFromBaseline();
    const change = diffTableDesign(baseDesign(), draft);
    expect(isChangeEmpty(change)).toBe(true);
    expect(change.pkChanged).toBe(false);
    expect(change.setPrimaryKey).toEqual([]);
    expect(change.addColumns).toHaveLength(0);
    expect(change.dropColumns).toHaveLength(0);
    expect(change.modifyColumns).toHaveLength(0);
  });

  it("detects an added column", () => {
    const draft = draftFromBaseline();
    draft.columns.push({
      name: "added",
      dataType: "text",
      nullable: true,
      default: null,
      comment: null,
    });
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.addColumns.map((c) => c.name)).toEqual(["added"]);
    expect(isChangeEmpty(change)).toBe(false);
  });

  it("detects a dropped column", () => {
    const draft = draftFromBaseline();
    draft.columns = draft.columns.filter((c) => c.name !== "score");
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.dropColumns).toEqual([{ name: "score" }]);
  });

  it("merges multiple field changes into a single modifyColumns entry", () => {
    const draft = draftFromBaseline();
    const score = draft.columns.find((c) => c.name === "score");
    if (!score) throw new Error("score missing");
    score.dataType = "double precision";
    score.nullable = false;
    score.default = "1";
    score.comment = "updated";
    const change = diffTableDesign(baseDesign(), draft);
    const m = change.modifyColumns.find((c) => c.name === "score");
    expect(m).toBeDefined();
    expect(m?.dataType).toBe("double precision");
    expect(m?.nullable).toBe(false);
    expect(m?.default).toBe("1");
    expect(m?.comment).toBe("updated");
  });

  it("does not flag a modify entry when no fields changed", () => {
    const draft = draftFromBaseline();
    // Touch but do not change
    const score = draft.columns.find((c) => c.name === "score");
    if (!score) throw new Error("score missing");
    void score;
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.modifyColumns.find((c) => c.name === "score")).toBeUndefined();
  });

  it("flags primary key replacement", () => {
    const draft = draftFromBaseline();
    draft.primaryKey = ["name"];
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.pkChanged).toBe(true);
    expect(change.setPrimaryKey).toEqual([{ name: null, columns: ["name"] }]);
    expect(isChangeEmpty(change)).toBe(false);
  });

  it("flags primary key drop (empty array)", () => {
    const draft = draftFromBaseline();
    draft.primaryKey = [];
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.pkChanged).toBe(true);
    expect(change.setPrimaryKey).toEqual([{ name: null, columns: [] }]);
  });

  it("flags constraint add and drop", () => {
    const draft = draftFromBaseline();
    draft.constraints = [
      ...draft.constraints,
      {
        name: "t_name_unique",
        type: "u",
        columns: ["name"],
      },
    ];
    draft.constraints = draft.constraints.filter((c) => c.name !== "t_score_check");
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.addConstraints.map((c) => c.name)).toEqual(["t_name_unique"]);
    expect(change.dropConstraints).toEqual([{ name: "t_score_check" }]);
  });

  it("flags index add and drop", () => {
    const draft = draftFromBaseline();
    draft.indexes = [];
    draft.indexes.push({
      name: "t_score_idx",
      unique: true,
      method: "btree",
      columns: [{ name: "score", desc: true }],
    });
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.dropIndexes).toEqual([{ name: "t_name_idx" }]);
    expect(change.addIndexes.map((i) => i.name)).toEqual(["t_score_idx"]);
  });

  it("flags foreign key add and drop", () => {
    const draft = draftFromBaseline();
    draft.foreignKeys = [
      ...draft.foreignKeys,
      {
        name: "t_score_fk",
        columns: ["score"],
        references: { schema: "public", table: "scores", columns: ["value"] },
        onDelete: null,
        onUpdate: null,
      },
    ];
    draft.foreignKeys = draft.foreignKeys.filter((fk) => fk.name !== "t_name_fk");
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.dropForeignKeys).toEqual([{ name: "t_name_fk" }]);
    expect(change.addForeignKeys.map((f) => f.name)).toEqual(["t_score_fk"]);
  });

  it("flags table comment change", () => {
    const draft = draftFromBaseline();
    draft.comment = "updated description";
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.hasCommentChange).toBe(true);
    expect(change.setComment).toBe("updated description");
  });

  it("does not flag modifyColumns for an unchanged column", () => {
    const draft = draftFromBaseline();
    // Make exactly one unrelated tweak — change the comment on name
    const name = draft.columns.find((c) => c.name === "name");
    if (!name) throw new Error("name missing");
    name.comment = null; // already null in baseline; should not flag
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.modifyColumns.find((c) => c.name === "name")).toBeUndefined();
    expect(change.hasCommentChange).toBe(false);
  });

  it("ignores column reorder (no reorder DDL in PG)", () => {
    const draft = draftFromBaseline();
    draft.columns = [draft.columns[2], draft.columns[1], draft.columns[0]];
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.addColumns).toHaveLength(0);
    expect(change.dropColumns).toHaveLength(0);
    expect(change.modifyColumns).toHaveLength(0);
  });

  it("PK unchanged but other fields changed → pkChanged false but change non-empty", () => {
    const draft = draftFromBaseline();
    const score = draft.columns.find((c) => c.name === "score");
    if (!score) throw new Error("score missing");
    score.comment = "different comment";
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.pkChanged).toBe(false);
    expect(isChangeEmpty(change)).toBe(false);
  });

  it("flags default removal as dropDefault (wire contract)", () => {
    const draft = draftFromBaseline();
    const id = draft.columns.find((c) => c.name === "id");
    if (!id) throw new Error("id missing");
    id.default = null;
    const change = diffTableDesign(baseDesign(), draft);
    const m = change.modifyColumns.find((c) => c.name === "id");
    expect(m).toBeDefined();
    expect(m?.dropDefault).toBe(true);
    expect(m?.default).toBeUndefined();
  });

  it("flags column comment removal as dropComment (wire contract)", () => {
    const draft = draftFromBaseline();
    const score = draft.columns.find((c) => c.name === "score");
    if (!score) throw new Error("score missing");
    score.comment = null;
    const change = diffTableDesign(baseDesign(), draft);
    const m = change.modifyColumns.find((c) => c.name === "score");
    expect(m).toBeDefined();
    expect(m?.dropComment).toBe(true);
    expect(m?.comment).toBeUndefined();
  });

  it("normalizes null FK actions to NO ACTION (Rust requires a string)", () => {
    const draft = draftFromBaseline();
    draft.foreignKeys.push({
      name: "t_new_fk",
      columns: ["score"],
      references: { schema: "public", table: "scores", columns: ["value"] },
      onDelete: null,
      onUpdate: null,
    });
    const change = diffTableDesign(baseDesign(), draft);
    const fk = change.addForeignKeys.find((f) => f.name === "t_new_fk");
    expect(fk).toBeDefined();
    expect(fk?.onDelete).toBe("NO ACTION");
    expect(fk?.onUpdate).toBe("NO ACTION");
  });

  it("clears the table comment with an empty string (wire contract)", () => {
    const draft = draftFromBaseline();
    draft.comment = null;
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.hasCommentChange).toBe(true);
    expect(change.setComment).toBe("");
  });

  it("PK unchanged → setPrimaryKey empty even though a column changed", () => {
    const draft = draftFromBaseline();
    const name = draft.columns.find((c) => c.name === "name");
    if (!name) throw new Error("name missing");
    name.nullable = true;
    const change = diffTableDesign(baseDesign(), draft);
    expect(change.pkChanged).toBe(false);
    expect(change.setPrimaryKey).toEqual([]);
    expect(isChangeEmpty(change)).toBe(false);
  });

  it("property: change is empty iff draft structurally equals baseline", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        (columnDelta, commentDelta) => {
          const baseline = baseDesign();
          const draft = draftFromDesign(baseline);
          // Optionally mutate up to columnDelta columns
          for (let i = 0; i < columnDelta; i += 1) {
            const col = draft.columns[i % draft.columns.length];
            if (!col) continue;
            col.comment = col.comment ? null : "twiddled";
          }
          if (commentDelta % 2 === 1) {
            draft.comment = draft.comment ? null : "touched";
          }
          const change = diffTableDesign(baseline, draft);
          const mutated = columnDelta > 0 || commentDelta % 2 === 1;
          expect(isChangeEmpty(change)).toBe(!mutated);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("draftFromDesign", () => {
  it("produces an editable draft mirroring the loaded design", () => {
    const design = baseDesign();
    const draft = draftFromDesign(design);
    expect(draft.columns).toHaveLength(3);
    expect(draft.primaryKey).toEqual(["id"]);
    expect(draft.constraints.map((c) => c.name)).toEqual(["t_score_check"]);
    expect(draft.indexes.map((i) => i.name)).toEqual(["t_name_idx"]);
    expect(draft.foreignKeys.map((f) => f.name)).toEqual(["t_name_fk"]);
    expect(draft.comment).toBe("baseline table");
  });

  it("filters the primary key constraint and FKs are kept separately", () => {
    const design = {
      ...baseDesign(),
      constraints: [
        ...baseDesign().constraints,
        {
          name: "fk_dup",
          type: "f" as const,
          definition: "FOREIGN KEY (x) REFERENCES other(id)",
          columns: ["x"],
          deferrable: false,
        },
      ],
    };
    const draft = draftFromDesign(design);
    // Constraints only keep u/c/x; primary FK is excluded (rendered separately).
    expect(draft.constraints.some((c) => c.name === "fk_dup")).toBe(false);
  });
});
