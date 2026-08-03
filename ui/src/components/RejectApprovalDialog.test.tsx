// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RejectApprovalDialog } from "./RejectApprovalDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function renderDialog(onConfirm = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <RejectApprovalDialog
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
  });
  return onConfirm;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("RejectApprovalDialog", () => {
  it("blocks empty rejection reasons before submit", () => {
    const onConfirm = renderDialog();
    const rejectButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Reject") as HTMLButtonElement;

    act(() => {
      rejectButton.click();
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("A rejection reason is required.");
  });

  it("trims the rejection reason passed to the caller", () => {
    const onConfirm = renderDialog();
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    const rejectButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Reject") as HTMLButtonElement;

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "  Wrong scope  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      rejectButton.click();
    });

    expect(onConfirm).toHaveBeenCalledWith("Wrong scope");
  });
});
