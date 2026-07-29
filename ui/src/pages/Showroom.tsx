import { FormEvent, useEffect, useMemo, useState } from "react";
import { useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";

type Showroom = { title: string; targetUrl: string; expiresAt: string };
type ShowroomContext = { route?: string; screen?: string; section?: string; sourceIssueId?: string };

function readError(value: unknown) {
  if (!value || typeof value !== "object") return "Feedback could not be sent.";
  const message = (value as { error?: { message?: unknown } }).error?.message;
  return typeof message === "string" ? message : "Feedback could not be sent.";
}

async function captureCurrentTab(): Promise<string> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screenshot capture is not supported in this browser.");
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("The selected screen could not be captured."));
      void video.play().catch(reject);
    });
    const maxWidth = 1_100;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length > 900_000) throw new Error("The screenshot is too large. Please reduce browser zoom and try again.");
    return dataUrl;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

export function ShowroomPage() {
  const { token = "" } = useParams();
  const [showroom, setShowroom] = useState<Showroom | null>(null);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [text, setText] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<ShowroomContext>({});

  const endpoint = useMemo(() => `/api/showrooms/${encodeURIComponent(token)}`, [token]);

  useEffect(() => {
    let active = true;
    void fetch(endpoint).then(async (response) => {
      if (!response.ok) throw new Error(readError(await response.json().catch(() => null)));
      return response.json() as Promise<Showroom>;
    }).then((value) => {
      if (!active) return;
      setShowroom(value);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "This review link is unavailable.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [endpoint]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setPanelOpen(true);
      }
      if (event.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!showroom) return;
    const targetOrigin = new URL(showroom.targetUrl).origin;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== targetOrigin || !event.data || typeof event.data !== "object") return;
      const data = event.data as { type?: unknown; context?: unknown };
      if (data.type !== "paperclip:showroom-context" || !data.context || typeof data.context !== "object") return;
      const candidate = data.context as ShowroomContext;
      setContext({
        route: typeof candidate.route === "string" ? candidate.route.slice(0, 2_000) : undefined,
        screen: typeof candidate.screen === "string" ? candidate.screen.slice(0, 200) : undefined,
        section: typeof candidate.section === "string" ? candidate.section.slice(0, 200) : undefined,
        sourceIssueId: typeof candidate.sourceIssueId === "string" ? candidate.sourceIssueId : undefined,
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [showroom]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError(null);
    try {
      const screenshotDataUrl = includeScreenshot ? await captureCurrentTab() : undefined;
      const response = await fetch(`${endpoint}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submissionId: crypto.randomUUID(),
          text: text.trim(),
          reporterName: reporterName.trim() || undefined,
          route: context.route ?? showroom?.targetUrl,
          context,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          screenshotDataUrl,
        }),
      });
      if (!response.ok) throw new Error(readError(await response.json().catch(() => null)));
      const created = await response.json() as { identifier: string };
      setNotice(`Danke — dein Feedback wurde als ${created.identifier} zur Prüfung an das Team gesendet.`);
      setText("");
      setPanelOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Feedback could not be sent.");
    } finally {
      setSending(false);
    }
  };

  if (loading) return <main className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">Showroom wird geladen …</main>;
  if (!showroom) return <main className="grid min-h-screen place-items-center bg-background px-6 text-center text-sm text-muted-foreground">{error ?? "This review link is unavailable."}</main>;

  return (
    <main className="relative h-dvh overflow-hidden bg-background text-foreground">
      <iframe title={showroom.title} src={showroom.targetUrl} className="h-full w-full border-0" />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-4 py-3 text-xs text-muted-foreground">
        <span className="rounded-full bg-background/90 px-3 py-1 shadow-sm backdrop-blur">{showroom.title}</span>
        <span className="rounded-full bg-background/90 px-3 py-1 shadow-sm backdrop-blur">Shift + F · Feedback</span>
      </div>
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        className="group fixed bottom-5 right-5 rounded-full border border-border bg-background px-3 py-3 text-xs font-medium shadow-sm transition hover:px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Feedback geben"
      >
        <span className="hidden group-hover:inline">Feedback geben</span><span className="group-hover:hidden">Feedback</span>
      </button>
      {notice && <p className="fixed bottom-5 left-5 max-w-sm rounded-lg border border-border bg-background p-3 text-sm shadow-sm">{notice}</p>}
      {panelOpen && (
        <div className="fixed inset-0 z-10 flex items-end justify-end bg-black/30 p-4 sm:p-6" role="presentation" onMouseDown={() => !sending && setPanelOpen(false)}>
          <form onSubmit={submit} onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-sm" aria-label="Showroom feedback">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Feedback</p>
            <h1 className="mt-2 text-xl font-bold">Was sollten wir verbessern?</h1>
            <p className="mt-2 text-sm text-muted-foreground">Dein Hinweis wird zuerst geprüft. Das Team sieht, auf welcher Ansicht du warst, und entscheidet dann über die passende Arbeit.</p>
            <label className="mt-5 block text-sm font-medium" htmlFor="showroom-feedback">Dein Hinweis</label>
            <Textarea id="showroom-feedback" autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder="Zum Beispiel: Dieser Schritt ist nicht verständlich, weil …" className="mt-2" disabled={sending} />
            <label className="mt-3 block text-sm font-medium" htmlFor="showroom-reporter">Name (optional)</label>
            <input id="showroom-reporter" value={reporterName} onChange={(event) => setReporterName(event.target.value)} className="mt-2 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" disabled={sending} />
            <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
              <Checkbox checked={includeScreenshot} onCheckedChange={(value) => setIncludeScreenshot(value === true)} disabled={sending} aria-label="Screenshot anhängen" />
              <span><strong>Screenshot anhängen</strong><br /><span className="text-muted-foreground">Dein Browser fragt dich vor der Aufnahme nach Erlaubnis. Wir speichern nur den von dir bestätigten Bildschirm.</span></span>
            </label>
            {error && <p className="mt-4 text-sm text-destructive" role="alert">{error}</p>}
            <div className="mt-5 flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setPanelOpen(false)} disabled={sending}>Abbrechen</Button>
              <Button type="submit" disabled={sending || !text.trim()}>{sending ? "Wird gesendet …" : "Feedback senden"}</Button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
