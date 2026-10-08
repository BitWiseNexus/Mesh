"use client";

import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import type { FlowSummary } from "@/lib/flows-api";
import { useRenameFlow } from "@/lib/flows-queries";

function RenameForm({ flow, onDone }: { flow: FlowSummary; onDone: () => void }) {
  const rename = useRenameFlow();
  const [name, setName] = useState(flow.name);
  const [description, setDescription] = useState(flow.description);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      await rename.mutateAsync({
        id: flow.flow_id,
        name: name.trim(),
        description: description.trim(),
      });
      onDone();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Couldn't rename the flow.");
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="flow-name">Name</Label>
        <Input
          id="flow-name"
          value={name}
          maxLength={200}
          autoFocus
          required
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="flow-description">Description</Label>
        <Textarea
          id="flow-description"
          value={description}
          maxLength={2000}
          rows={3}
          placeholder="What does this flow do?"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!name.trim() || rename.isPending}>
          {rename.isPending && <Loader2 className="animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RenameFlowDialog({
  flow,
  onOpenChange,
}: {
  flow: FlowSummary | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={flow !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename flow</DialogTitle>
          <DialogDescription>Change how this flow appears in your list.</DialogDescription>
        </DialogHeader>
        {/* key: fresh form state for each flow */}
        {flow && <RenameForm key={flow.flow_id} flow={flow} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
