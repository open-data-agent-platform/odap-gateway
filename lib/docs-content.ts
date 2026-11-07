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
    title: "Inspect a demo SQL draft",
    summary:
      "The workbench uses local rule-based drafting and a bundled sample schema, not a general-purpose model or a live tenant catalog.",
    steps: [
      "Open Tools to inspect a draft for a supported sample question.",
      "Review the SQL and sample fields; the draft is not evidence of access to your warehouse.",
      "Copying a draft is not an execution approval. Raw SQL dry-runs remain disabled in production."
    ]
  },
  {
    id: "schema-catalog",
    title: "Review legacy schema policy",
    summary:
      "Legacy queryable and PII flags are separate from tenant-scoped Semantic Releases and Approval Contracts.",
    steps: [
      "A configured administrator can inspect stored catalog fields and their queryable and PII flags.",
      "The legacy BigQuery schema importer is disabled in production; credentials do not enable it.",
      "Changing a field flag does not publish a Semantic Release or grant permission to execute a query."
    ]
  },
  {
    id: "dry-run-review",
    title: "Interpret demo preview records",
    summary:
      "On an isolated demo deployment, distinguish local estimates from provider dry-run responses and persisted review records.",
    steps: [
      "Check the result mode and persistence status. A simulation is not a warehouse observation.",
      "Scan and cost estimates are not final billing; displayed runtime estimates are not measured query execution time.",
      "Legacy approve/block review does not issue an Approval Contract and does not dispatch a BigQuery job."
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
      "The editor's raw SQL dry-runs are disabled in production. Adding service-account credentials does not enable them, and the editor does not dispatch executable BigQuery jobs. Live dry-runs exist only for explicitly configured, isolated demo deployments. Do not switch a production deployment to demo mode. The separate release-bound adapter requires its own authority, budget and operational setup; local tests do not establish a production integration."
  },
  {
    question: "What does a structured metric preview confirm?",
    answer:
      "It checks current tenant membership and compiles a supported metric against an eligible Semantic Release. This compilation does not contact BigQuery, does not estimate warehouse cost, and does not authorize execution. A later operation must separately satisfy its Approval Contract, current authority and budget checks."
  },
  {
    question: "Does the preview mean Gateway acceptance is complete?",
    answer:
      "No. A deployed preview and passing engineering tests are not formal Gateway acceptance. Independent client integrations, external pilot acceptance and separately held-out evaluation still need evidence. OAuth and administrator access also require explicit setup; deployment alone does not configure them."
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
