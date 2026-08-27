import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export type DatabaseConnectionDialogSection = {
  readonly id: string;
  readonly label: string;
};

export function DatabaseConnectionDialogShell({
  open,
  onOpenChange,
  testId,
  title,
  sections,
  activeSection,
  onActiveSectionChange,
  children,
  saveLabel,
  primaryLabel,
  onSave,
  onPrimary,
  busy = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly testId: string;
  readonly title: string;
  readonly sections: readonly DatabaseConnectionDialogSection[];
  readonly activeSection: string;
  readonly onActiveSectionChange: (section: string) => void;
  readonly children: ReactNode;
  readonly saveLabel: string;
  readonly primaryLabel: string;
  readonly onSave: () => void;
  readonly onPrimary: () => void;
  readonly busy?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 flex max-h-[min(560px,calc(100vh-32px))] w-[720px] !max-w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden rounded-md p-0"
        data-testid={testId}
      >
        <DialogHeader className="h-12 shrink-0 justify-center border-b px-4 py-0">
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <aside className="w-36 shrink-0 overflow-y-auto border-r bg-muted/20 p-1.5">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`block h-7 w-full rounded-sm px-2 text-left text-[12px] ${activeSection === section.id ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}
                onClick={() => onActiveSectionChange(section.id)}
              >
                {section.label}
              </button>
            ))}
          </aside>
          <div className="min-w-0 flex-1 overflow-y-auto p-4">{children}</div>
        </div>
        <div className="flex h-14 shrink-0 justify-end gap-2 border-t px-4 py-3">
          <Button size="sm" type="button" variant="outline" className="rounded-sm" onClick={onSave}>
            {saveLabel}
          </Button>
          <Button size="sm" type="button" className="rounded-sm" onClick={onPrimary} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {primaryLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DatabaseConnectionFormGrid({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

export function DatabaseConnectionField({
  label,
  children,
  fullWidth = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly fullWidth?: boolean;
}) {
  return (
    <div className={`${fullWidth ? "col-span-2" : ""} space-y-1`}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

export function DatabaseConnectionToggleRow({ children }: { readonly children: ReactNode }) {
  return <div className="col-span-2 flex h-9 items-center gap-2">{children}</div>;
}
