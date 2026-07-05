import { describe, expect, it } from "vitest";
import {
  onRequestGet,
  onRequestPost
} from "../functions/api/docs/feedback";
import { onRequestPatch as onAdminDocsFeedbackPatch } from "../functions/api/admin/docs-feedback/[id]";
import { updateDocsFeedbackReview } from "../lib/docs-feedback";

describe("docs feedback API", () => {
  it("returns seed feedback when D1 is not configured", async () => {
    const response = await onRequestGet({
      request: new Request("https://odap-gateway.example/api/docs/feedback"),
      env: {}
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      persisted: false,
      feedback: expect.arrayContaining([
        expect.objectContaining({
          id: "seed-docs-question-1",
          kind: "question",
          answerText: expect.stringContaining("Dry-run results")
        })
      ])
    });
  });

  it("accepts valid questions in preview mode", async () => {
    const response = await onRequestPost({
      request: new Request("https://odap-gateway.example/api/docs/feedback", {
        method: "POST",
        body: JSON.stringify({
          kind: "question",
          topic: "Schema catalog",
          authorName: "Reader",
          authorEmail: "",
          message: "How do I connect schema policy to generated SQL?"
        })
      }),
      env: {}
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      accepted: true,
      pendingReview: true,
      persisted: false,
      feedback: expect.objectContaining({
        kind: "question",
        status: "pending"
      })
    });
  });

  it("rejects short feedback messages", async () => {
    const response = await onRequestPost({
      request: new Request("https://odap-gateway.example/api/docs/feedback", {
        method: "POST",
        body: JSON.stringify({
          kind: "comment",
          topic: "Docs",
          message: "Too short"
        })
      }),
      env: {}
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "feedback_message_required"
    });
  });

  it("silently accepts honeypot submissions without persistence", async () => {
    const response = await onRequestPost({
      request: new Request("https://odap-gateway.example/api/docs/feedback", {
        method: "POST",
        body: JSON.stringify({
          kind: "question",
          topic: "Docs",
          message: "This has enough detail to pass validation.",
          company: "bot-filled-field"
        })
      }),
      env: {}
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      accepted: true,
      feedback: null,
      persisted: false
    });
  });

  it("requires D1 persistence for admin answers", async () => {
    const result = await updateDocsFeedbackReview(
      {},
      "seed-docs-question-1",
      {
        status: "approved",
        answerText: "This answer has enough detail to publish."
      },
      "admin@example.com"
    );

    expect(result).toMatchObject({
      ok: false,
      code: "storage_not_configured"
    });
  });

  it("requires an admin session for answer management", async () => {
    const response = await onAdminDocsFeedbackPatch({
      request: new Request(
        "https://odap-gateway.example/api/admin/docs-feedback/seed-docs-question-1",
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "approved",
            answerText: "Publish this answer after review."
          })
        }
      ),
      env: {},
      params: {
        id: "seed-docs-question-1"
      }
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "auth_not_configured"
    });
  });
});
