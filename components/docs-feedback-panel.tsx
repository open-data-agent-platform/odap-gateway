"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { MessageSquareText, RefreshCw, Send, Sparkles } from "lucide-react";
import type {
  DocsFeedbackKind,
  PublicDocsFeedback
} from "@/lib/docs-content";
import { cn } from "@/lib/utils";
import { loadDocsFeedback, sendDocsFeedback } from "@/lib/docs-feedback-client";

type FeedbackLoadState =
  | { status: "loading" }
  | { status: "ready"; feedback: PublicDocsFeedback[] }
  | { status: "error" };

const topics = [
  "Getting started",
  "BigQuery dry-run",
  "Schema catalog",
  "Admin review",
  "Governance",
  "Other"
];

export function DocsFeedbackPanel() {
  const [loadState, setLoadState] = useState<FeedbackLoadState>({
    status: "loading"
  });
  const [kind, setKind] = useState<DocsFeedbackKind>("question");
  const [topic, setTopic] = useState(topics[0]);
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [message, setMessage] = useState("");
  const [company, setCompany] = useState("");
  const [notice, setNotice] = useState<{status:"success" | "error";message:string} | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const submission = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadDocsFeedback(controller.signal).then(result => {
      if (!controller.signal.aborted) setLoadState(result.state === "ready"
        ? {status:"ready",feedback:result.feedback} : {status:"error"});
    });
    return () => controller.abort();
  }, [loadKey]);

  useEffect(() => () => submission.current?.abort(), []);

  const visibleFeedback = loadState.status === "ready" ? loadState.feedback : [];

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submission.current) return;
    setNotice(null);

    if (message.trim().length < 12) {
      setNotice({status:"error",message:"Please add a little more detail before submitting."});
      return;
    }

    const controller = new AbortController();
    submission.current = controller;
    setSubmitting(true);
    try {
      const result = await sendDocsFeedback({kind,topic,authorName,authorEmail,message,company},controller.signal);
      if (controller.signal.aborted) return;
      if (result.state !== "confirmed") {
        setNotice({status:"error",message:"Submission could not be confirmed. Your draft is unchanged."});
        return;
      }
      setMessage("");
      setAuthorName("");
      setAuthorEmail("");
      setNotice({status:"success",message:"Submitted. Pending review."});
    } finally {
      submission.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return (
    <section
      id="community"
      className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(360px,0.72fr)]"
    >
      <div className="min-w-0 rounded-lg border border-[#edeae1]/10 bg-[#111a2e] p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <MessageSquareText className="h-5 w-5 text-[#c9a35a]" />
          <h2 className="text-xl font-semibold text-[#edeae1]">
            Community questions
          </h2>
          <button type="button" title="Reload feedback" aria-label="Reload feedback"
            disabled={loadState.status === "loading"}
            onClick={() => {setLoadState({status:"loading"});setLoadKey(key => key+1);}}
            className="focus-ring ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#9aa2b7] hover:text-white disabled:opacity-50">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-3 text-sm leading-7 text-[#9aa2b7]">
          Approved comments and questions from readers. Platform admins review
          submissions, answer questions in Admin, and publish them here.
        </p>
        <div className="mt-5 divide-y divide-[#edeae1]/10 rounded-lg border border-[#edeae1]/10 bg-[#090d17]">
          {loadState.status === "loading" ? (
            <div className="p-4 text-sm text-[#9aa2b7]">Loading feedback...</div>
          ) : null}
          {loadState.status === "error" ? (
            <p role="alert" className="p-4 text-sm text-[#e4c887]">Feedback is unavailable.</p>
          ) : null}
          {loadState.status === "ready" && visibleFeedback.length === 0 ? (
            <p className="p-4 text-sm text-[#9aa2b7]">No published feedback yet.</p>
          ) : null}
          {visibleFeedback.map((item) => (
            <article key={item.id} className="min-w-0 p-4 [overflow-wrap:anywhere]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded border px-2 py-1 text-[11px] font-semibold",
                      item.kind === "question"
                        ? "border-[#7fa6ff]/25 bg-[#7fa6ff]/10 text-[#93c5fd]"
                        : "border-[#c9a35a]/25 bg-[#c9a35a]/10 text-[#e4c887]"
                    )}
                  >
                    {item.kind}
                  </span>
                  <span className="text-xs text-[#6e7690]">{item.topic}</span>
                </div>
                <span className="text-[11px] text-[#6e7690]">
                  {formatDate(item.createdAt)}
                </span>
              </div>
              <p className="mt-3 text-sm leading-7 text-[#edeae1]">
                {item.message}
              </p>
              {item.answerText ? (
                <div className="mt-4 rounded-md border border-[#34a853]/20 bg-[#34a853]/10 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#4ade80]">
                    Official answer
                  </p>
                  <p className="mt-2 text-sm leading-7 text-[#d8f5df]">
                    {item.answerText}
                  </p>
                  <p className="mt-2 text-[11px] text-[#9aa2b7]">
                    {item.answeredBy ?? "Platform admin"}
                    {item.answeredAt ? ` / ${formatDate(item.answeredAt)}` : ""}
                  </p>
                </div>
              ) : null}
              <p className="mt-3 text-xs text-[#9aa2b7]">
                {item.authorName}
                {item.status === "pending" ? " / pending review" : ""}
              </p>
            </article>
          ))}
        </div>
      </div>

      <form
        onSubmit={(event) => void submitFeedback(event)}
        className="min-w-0 rounded-lg border border-[#2b3654] bg-[linear-gradient(180deg,#151f37,#111a2e)] p-5 shadow-[0_24px_64px_rgba(0,0,0,0.28)] sm:p-6"
      >
        <div className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 text-[#7fa6ff]" />
          <h2 className="text-xl font-semibold text-[#edeae1]">
            Ask or comment
          </h2>
        </div>
        <p className="mt-3 text-sm leading-7 text-[#9aa2b7]">
          Tell us where the guide is unclear, ask a question, or suggest a topic.
          Admins review submissions and publish answers in the community list.
        </p>

        <fieldset disabled={submitting} className="mt-5 grid min-w-0 gap-3">
          <label className="grid gap-2 text-sm font-medium text-[#edeae1]">
            Type
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.currentTarget.value as DocsFeedbackKind)
              }
              className="h-11 rounded-md border border-[#2b3654] bg-[#090d17] px-3 text-sm text-[#edeae1] outline-none focus:border-[#c9a35a]"
            >
              <option value="question">Question</option>
              <option value="comment">Comment</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-[#edeae1]">
            Topic
            <select
              value={topic}
              onChange={(event) => setTopic(event.currentTarget.value)}
              className="h-11 rounded-md border border-[#2b3654] bg-[#090d17] px-3 text-sm text-[#edeae1] outline-none focus:border-[#c9a35a]"
            >
              {topics.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-2 text-sm font-medium text-[#edeae1]">
              Name
              <input
                value={authorName}
                onChange={(event) => setAuthorName(event.currentTarget.value)}
                maxLength={80}
                placeholder="Anonymous"
                className="h-11 min-w-0 w-full rounded-md border border-[#2b3654] bg-[#090d17] px-3 text-sm text-[#edeae1] outline-none placeholder:text-[#6e7690] focus:border-[#c9a35a]"
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-[#edeae1]">
              Email
              <input
                value={authorEmail}
                onChange={(event) => setAuthorEmail(event.currentTarget.value)}
                maxLength={160}
                placeholder="optional"
                type="email"
                className="h-11 min-w-0 w-full rounded-md border border-[#2b3654] bg-[#090d17] px-3 text-sm text-[#edeae1] outline-none placeholder:text-[#6e7690] focus:border-[#c9a35a]"
              />
            </label>
          </div>
          <label className="hidden">
            Company
            <input
              tabIndex={-1}
              autoComplete="off"
              value={company}
              onChange={(event) => setCompany(event.currentTarget.value)}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-[#edeae1]">
            Message
            <textarea
              value={message}
              onChange={(event) => setMessage(event.currentTarget.value)}
              maxLength={1200}
              rows={6}
              placeholder="Ask a question or leave a comment..."
              className="resize-none rounded-md border border-[#2b3654] bg-[#090d17] px-3 py-3 text-sm leading-6 text-[#edeae1] outline-none placeholder:text-[#6e7690] focus:border-[#c9a35a]"
            />
          </label>
        </fieldset>

        {notice ? (
          <p role={notice.status === "error" ? "alert" : "status"}
            className="mt-4 rounded-md border border-[#c9a35a]/20 bg-[#c9a35a]/10 px-3 py-2 text-xs leading-5 text-[#e4c887]">
            {notice.message}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="focus-ring mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#c9a35a] px-5 text-sm font-semibold text-[#090d17] transition hover:bg-[#e4c887] disabled:cursor-wait disabled:opacity-70"
        >
          <Send className="h-4 w-4" />
          {submitting ? "Submitting..." : "Submit for review"}
        </button>
      </form>
    </section>
  );
}

function formatDate(value: string) {
  if (!value.includes("T")) {
    return value;
  }

  return value.slice(0, 10);
}
