import { z } from "zod";

const showroomUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "Showroom target must use http or https");

export const createShowroomSchema = z.object({
  targetUrl: showroomUrlSchema,
  title: z.string().trim().min(1).max(120),
  projectId: z.string().uuid().nullable().optional(),
  expiresInHours: z.number().int().min(1).max(24 * 30).default(24 * 14),
});

export const showroomFeedbackSchema = z.object({
  submissionId: z.string().uuid(),
  text: z.string().trim().min(1).max(5_000),
  reporterName: z.string().trim().min(1).max(100).optional(),
  route: z.string().trim().max(2_000).optional(),
  viewport: z.object({
    width: z.number().int().min(1).max(10_000),
    height: z.number().int().min(1).max(10_000),
  }),
  // The loaded app may publish this narrow context to its parent frame with
  // postMessage. Only a valid Paperclip issue in the same company is routed
  // automatically; every other report remains in the human triage queue.
  context: z.object({
    screen: z.string().trim().min(1).max(200).optional(),
    section: z.string().trim().min(1).max(200).optional(),
    sourceIssueId: z.string().uuid().optional(),
  }).optional(),
  // Present only after the reviewer explicitly grants browser tab capture.
  // Fits beneath Paperclip's normal JSON-body limit; the browser scales capture
  // before encoding so a review report cannot become an upload vector.
  screenshotDataUrl: z.string().max(900_000).optional(),
});

export type CreateShowroom = z.infer<typeof createShowroomSchema>;
export type ShowroomFeedback = z.infer<typeof showroomFeedbackSchema>;
