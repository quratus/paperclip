import { FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

type CreatedShowroom = { url: string; expiresAt: string };

function readError(value: unknown) {
  if (!value || typeof value !== "object") return "The review link could not be created.";
  const message = (value as { error?: { message?: unknown } }).error?.message;
  return typeof message === "string" ? message : "The review link could not be created.";
}

export function Showrooms() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [title, setTitle] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("336");
  const [created, setCreated] = useState<CreatedShowroom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setBreadcrumbs([{ label: "Showrooms" }]), [setBreadcrumbs]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedCompanyId) return;
    setSaving(true);
    setError(null);
    setCreated(null);
    try {
      const response = await fetch(`/api/companies/${selectedCompanyId}/showrooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, targetUrl, expiresInHours: Number(expiresInHours) }),
      });
      if (!response.ok) throw new Error(readError(await response.json().catch(() => null)));
      setCreated(await response.json() as CreatedShowroom);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The review link could not be created.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Showrooms</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Create a review link</h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">Send a focused, expiring frame to a collaborator. Feedback routes to matching work when the loaded app publishes context; otherwise it enters human triage.</p>
      <form className="mt-8 space-y-5 rounded-xl border border-border bg-card p-6" onSubmit={create}>
        <label className="block text-sm font-medium" htmlFor="showroom-title">Name</label>
        <Input id="showroom-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Costa — approval-flow review" required disabled={saving} />
        <label className="block text-sm font-medium" htmlFor="showroom-target">Public app URL</label>
        <Input id="showroom-target" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://review.example.com" type="url" required disabled={saving} />
        <label className="block text-sm font-medium" htmlFor="showroom-expiry">Expires after (hours)</label>
        <Input id="showroom-expiry" value={expiresInHours} onChange={(event) => setExpiresInHours(event.target.value)} type="number" min="1" max="720" required disabled={saving} />
        <p className="text-xs text-muted-foreground">Screenshots are never captured silently: reviewers explicitly approve browser capture when they submit feedback.</p>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button type="submit" disabled={saving || !selectedCompanyId}>{saving ? "Creating …" : "Create review link"}</Button>
      </form>
      {created && (
        <section className="mt-6 rounded-xl border border-border bg-card p-6" aria-live="polite">
          <p className="font-medium">Review link ready</p>
          <p className="mt-1 text-sm text-muted-foreground">Expires {new Date(created.expiresAt).toLocaleString()}.</p>
          <Input className="mt-4" readOnly value={created.url} aria-label="Showroom review link" />
          <Button className="mt-3" type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(created.url)}>Copy link</Button>
        </section>
      )}
    </main>
  );
}
