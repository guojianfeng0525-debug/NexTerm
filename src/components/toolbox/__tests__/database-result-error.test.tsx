import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DatabaseResultErrorPane,
  type DatabaseResultErrorPaneLabels,
} from "@/components/toolbox/database-result-error";
import type { ParsedDatabaseError } from "@/lib/database/database-error";

const labels: DatabaseResultErrorPaneLabels = {
  error: "执行失败",
  copy: "复制错误",
  retry: "重试",
  jumpToLine: "跳转到出错行",
  line: (n) => `第 ${n} 行`,
  details: "服务端详情",
};

function makeError(overrides: Partial<ParsedDatabaseError> = {}): ParsedDatabaseError {
  return {
    message: 'relation "users" does not exist',
    fullText: 'ERROR: relation "users" does not exist\nLINE 3: FROM users;',
    code: "42P01",
    lineNumber: 3,
    lineText: "FROM users;",
    source: "postgres",
    ...overrides,
  };
}

afterEach(cleanup);

describe("DatabaseResultErrorPane", () => {
  it("renders the title, code-prefixed message and LINE badge", () => {
    render(
      <DatabaseResultErrorPane
        error={makeError()}
        labels={labels}
        onRetry={() => undefined}
        onCopy={() => undefined}
        onGoToLine={() => undefined}
      />,
    );
    expect(screen.getByText("执行失败")).not.toBeNull();
    expect(
      screen.getByText('42P01: relation "users" does not exist'),
    ).not.toBeNull();
    expect(screen.getByText("第 3 行")).not.toBeNull();
  });

  it("renders the message without a code prefix when no code exists", () => {
    render(
      <DatabaseResultErrorPane
        error={makeError({ code: undefined })}
        labels={labels}
      />,
    );
    expect(
      screen.getByText('relation "users" does not exist'),
    ).not.toBeNull();
    // No code → no suggestion row for an unknown-code error.
    expect(screen.queryByText(/Access denied|does not exist — check/i)).toBeNull();
  });

  it("shows a suggestion only for known error codes", () => {
    const { rerender } = render(
      <DatabaseResultErrorPane
        error={makeError({ code: "42P01" })}
        labels={labels}
      />,
    );
    expect(screen.getByText(/check the table\/schema name/i)).not.toBeNull();

    rerender(
      <DatabaseResultErrorPane
        error={makeError({ code: "99999" })}
        labels={labels}
      />,
    );
    expect(screen.queryByText(/check the table\/schema name/i)).toBeNull();
  });

  it("hides the LINE badge when no line number is present", () => {
    render(
      <DatabaseResultErrorPane
        error={makeError({ lineNumber: undefined, lineText: undefined })}
        labels={labels}
      />,
    );
    expect(screen.queryByText(/第 \d+ 行/)).toBeNull();
  });

  it("calls the retry / copy callbacks and hides the jump button when absent", () => {
    const onRetry = vi.fn();
    const onCopy = vi.fn();
    const { rerender } = render(
      <DatabaseResultErrorPane
        error={makeError()}
        labels={labels}
        onRetry={onRetry}
        onCopy={onCopy}
      />,
    );
    // onGoToLine absent → jump button hidden.
    expect(screen.queryByTestId("database-result-error-goto")).toBeNull();
    expect(screen.getByTestId("database-result-error-retry")).not.toBeNull();
    expect(screen.getByTestId("database-result-error-copy")).not.toBeNull();

    fireEvent.click(screen.getByTestId("database-result-error-retry"));
    fireEvent.click(screen.getByTestId("database-result-error-copy"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledTimes(1);

    // With onGoToLine present the jump button appears and fires.
    const onGoToLine = vi.fn();
    rerender(
      <DatabaseResultErrorPane
        error={makeError()}
        labels={labels}
        onRetry={onRetry}
        onCopy={onCopy}
        onGoToLine={onGoToLine}
      />,
    );
    fireEvent.click(screen.getByTestId("database-result-error-goto"));
    expect(onGoToLine).toHaveBeenCalledTimes(1);
  });

  it("disables retry / copy buttons when their callbacks are missing", () => {
    render(<DatabaseResultErrorPane error={makeError()} labels={labels} />);
    const retry = screen.getByTestId("database-result-error-retry");
    const copy = screen.getByTestId("database-result-error-copy");
    if (!(retry instanceof HTMLButtonElement) || !(copy instanceof HTMLButtonElement)) {
      throw new Error("expected buttons");
    }
    expect(retry.disabled).toBe(true);
    expect(copy.disabled).toBe(true);
  });

  it("shows server details in the collapsible and toggles it", () => {
    render(
      <DatabaseResultErrorPane
        error={makeError()}
        labels={labels}
        onRetry={() => undefined}
        onCopy={() => undefined}
      />,
    );
    // Closed by default → detail text hidden.
    expect(screen.queryByTestId("database-result-error-details")).toBeNull();
    fireEvent.click(screen.getByTestId("database-result-error-details-trigger"));
    const details = screen.getByTestId("database-result-error-details");
    expect(details.textContent).toContain('ERROR: relation "users" does not exist');
    expect(details.textContent).toContain("LINE 3: FROM users;");
  });
});
