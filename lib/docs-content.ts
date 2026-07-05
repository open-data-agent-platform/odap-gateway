export type DocsGuide = {
  id: string;
  title: string;
  summary: string;
  steps: string[];
};

export type DocsFaq = {
  question: string;
  answer: string;
};

export type DocsFeedbackKind = "comment" | "question";
export type DocsFeedbackStatus = "approved" | "pending";

export type PublicDocsFeedback = {
  id: string;
  kind: DocsFeedbackKind;
  topic: string;
  authorName: string;
  message: string;
  status: DocsFeedbackStatus;
  answerText?: string;
  answeredBy?: string;
  answeredAt?: string;
  createdAt: string;
};

export const docsGuides: DocsGuide[] = [
  {
    id: "first-query",
    title: "Generate your first SQL query",
    summary:
      "Use the workbench to turn a plain-English business question into schema-aware BigQuery SQL.",
    steps: [
      "Open Tools and describe the business question in plain English.",
      "Review the generated SQL, referenced tables, and highlighted schema fields.",
      "Run a dry-run check before copying or sending the query for approval."
    ]
  },
  {
    id: "schema-catalog",
    title: "Manage schema context",
    summary:
      "Keep generated SQL aligned with approved datasets, queryable fields, and PII policy.",
    steps: [
      "Sign in as an admin and open the Schema Catalog panel.",
      "Mark fields as queryable when they are safe for generated SQL.",
      "Flag PII fields so future execution policies can block risky selections."
    ]
  },
  {
    id: "dry-run-review",
    title: "Review dry-run results",
    summary:
      "Use cost, scan volume, runtime, and safety checks before any production execution path.",
    steps: [
      "Submit a query from the workbench or inspect a queued run in Admin.",
      "Review scan bytes, estimated cost, referenced tables, and safety checks.",
      "Approve safe runs or block queries that need rewrite or schema changes."
    ]
  }
];

export const docsFaqs: DocsFaq[] = [
  {
    question: "Is Open Data Agent Platform affiliated with Google?",
    answer:
      "No. Open Data Agent Platform is an independent product and is not affiliated with, endorsed by, or sponsored by Google."
  },
  {
    question: "Can the site execute live BigQuery jobs?",
    answer:
      "The current production path supports live BigQuery dry-runs when a service account is configured. Real execution remains gated for a later phase."
  },
  {
    question: "Where do user comments and questions go?",
    answer:
      "Submitted docs feedback is stored in Cloudflare D1 when available and starts in pending review status. Admins answer and publish items from the Admin console. Approved questions, comments, and official answers appear in the Community questions section."
  },
  {
    question: "Can non-admin users read the Docs page?",
    answer:
      "Yes. The Docs page is public. Admin-only actions such as schema policy management stay protected behind the admin console."
  }
];

export const seedDocsFeedback: PublicDocsFeedback[] = [
  {
    id: "seed-docs-question-1",
    kind: "question",
    topic: "BigQuery dry-run",
    authorName: "Data analyst",
    message:
      "Can I see the estimated bytes before asking an admin to approve a generated query?",
    status: "approved",
    answerText:
      "Yes. Dry-run results show estimated bytes, cost, runtime, referenced tables, and safety checks before an admin approves a run.",
    answeredBy: "Platform admin",
    answeredAt: "2026-06-22T00:00:00.000Z",
    createdAt: "2026-06-22T00:00:00.000Z"
  },
  {
    id: "seed-docs-comment-1",
    kind: "comment",
    topic: "Schema catalog",
    authorName: "Workspace owner",
    message:
      "The field-level queryable and PII toggles make the approval workflow much easier to explain to analysts.",
    status: "approved",
    createdAt: "2026-06-22T00:00:00.000Z"
  }
];
