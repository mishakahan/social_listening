import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useCompany, type Company } from "@/hooks/use-company";

const NEW_COMPANY = "__new__";

export function CompanySwitcher() {
  const { companyId, setCompanyId, companies } = useCompany();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");

  const createCompany = useMutation({
    mutationFn: async (companyName: string): Promise<Company> => {
      const res = await fetch("/api/pipeline/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: companyName }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: async (company) => {
      await queryClient.invalidateQueries({ queryKey: ["companies"] });
      setCompanyId(company.id);
      setDialogOpen(false);
      setName("");
    },
  });

  const handleChange = (value: string) => {
    if (value === NEW_COMPANY) {
      setDialogOpen(true);
      return;
    }
    setCompanyId(Number(value));
  };

  return (
    <>
      <Select value={String(companyId)} onValueChange={handleChange}>
        <SelectTrigger className="h-9 w-52 text-sm" aria-label="Select company">
          <Building2 className="h-4 w-4 mr-2 flex-shrink-0 text-muted-foreground" />
          <SelectValue placeholder="Select company" />
        </SelectTrigger>
        <SelectContent>
          {companies.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              {c.name}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={NEW_COMPANY}>+ New company</SelectItem>
        </SelectContent>
      </Select>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New company</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Company name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) createCompany.mutate(name.trim());
            }}
          />
          {createCompany.isError && (
            <p className="text-sm text-destructive">
              {(createCompany.error as Error).message || "Failed to create company"}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createCompany.mutate(name.trim())}
              disabled={!name.trim() || createCompany.isPending}
            >
              {createCompany.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
