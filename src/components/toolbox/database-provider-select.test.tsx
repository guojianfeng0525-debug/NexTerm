import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DatabaseProviderSelect } from "./database-provider-select";

describe("DatabaseProviderSelect", () => {
  it("renders both registered providers and returns their provider IDs", () => {
    const onValueChange = vi.fn();
    render(<DatabaseProviderSelect value="postgresql" onValueChange={onValueChange} />);

    fireEvent.click(screen.getByTestId("database-provider-select"));
    expect(screen.getByRole("option", { name: "PostgreSQL" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "SQLite (Experimental)" })).not.toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "SQLite (Experimental)" }));
    expect(onValueChange).toHaveBeenCalledWith("sqlite");
  });
});
