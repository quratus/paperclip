import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export function RejectApprovalDialog({
  open,
  title = "Reject approval",
  description = "Give the rework owner one clear line about what needs to change.",
  pending = false,
  error = null,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title?: string;
  description?: string;
  pending?: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (decisionNote: string) => void;
}) {
  const [note, setNote] = useState("");
  const [attempted, setAttempted] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const trimmed = note.trim();
  const showRequired = attempted && trimmed.length === 0;

  useEffect(() => {
    if (!open) {
      setNote("");
      setAttempted(false);
      return;
    }
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (pending) return;
      onOpenChange(nextOpen);
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Textarea
            ref={inputRef}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="One-line rejection reason"
            aria-invalid={showRequired}
            className="min-h-24"
            disabled={pending}
          />
          {showRequired && (
            <p className="text-xs text-destructive">A rejection reason is required.</p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              setAttempted(true);
              if (!trimmed) return;
              onConfirm(trimmed);
            }}
            disabled={pending}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
