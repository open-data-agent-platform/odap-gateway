import type { D1Database } from "./d1";
import {
  seedDocsFeedback,
  type DocsFeedbackKind,
  type DocsFeedbackStatus,
  type PublicDocsFeedback
} from "./docs-content";

export type DocsFeedbackEnv = {
  ODAP_GATEWAY_DB?: D1Database;
  DB?: D1Database;
};

export type DocsFeedbackSubmission = {
  kind: DocsFeedbackKind;
  topic: string;
  authorName: string;
  authorEmail: string;
  message: string;
};

export type AdminDocsFeedback = PublicDocsFeedback & {
  authorEmail: string | null;
};

export type DocsFeedbackReviewInput = {
  status?: DocsFeedbackStatus;
  answerText?: string;
};

export type DocsFeedbackMutationResult =
  | {
      ok: true;
      feedback: PublicDocsFeedback | AdminDocsFeedback;
      persisted: boolean;
      storageBinding: "ODAP_GATEWAY_DB" | "DB" | null;
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 500;
      code: string;
      message: string;
    };

type DocsFeedbackRow = {
  id: string;
  kind: DocsFeedbackKind;
  topic: string;
  author_name: string;
  author_email: string | null;
  message: string;
  status: DocsFeedbackStatus;
  answer_text: string | null;
  answered_by: string | null;
  answered_at: string | null;
  created_at: string;
};

const MAX_NAME_LENGTH = 80;
const MAX_TOPIC_LENGTH = 120;
const MAX_EMAIL_LENGTH = 160;
const MAX_MESSAGE_LENGTH = 1200;
const MAX_ANSWER_LENGTH = 1600;

export async function listPublicDocsFeedback(
  env: DocsFeedbackEnv
): Promise<{
  feedback: PublicDocsFeedback[];
  persisted: boolean;
  storageBinding: "ODAP_GATEWAY_DB" | "DB" | null;
}> {
  const configured = getDocsFeedbackDb(env);
  if (!configured) {
    return {
      feedback: seedDocsFeedback,
      persisted: false,
      storageBinding: null
    };
  }

  await ensureDocsFeedbackSchema(configured.db);
  const response = await configured.db
    .prepare(
      `SELECT
        id,
        kind,
        topic,
        author_name,
        author_email,
        message,
        status,
        answer_text,
        answered_by,
        answered_at,
        created_at
      FROM docs_feedback
      WHERE status = 'approved'
      ORDER BY created_at DESC
      LIMIT 20`
    )
    .all<DocsFeedbackRow>();
  const rows = (response.results ?? []).map(mapDocsFeedbackRow);

  return {
    feedback: rows.length ? rows : seedDocsFeedback,
    persisted: true,
    storageBinding: configured.binding
  };
}

export async function listAdminDocsFeedback(
  env: DocsFeedbackEnv
): Promise<{
  feedback: AdminDocsFeedback[];
  persisted: boolean;
  storageBinding: "ODAP_GATEWAY_DB" | "DB" | null;
}> {
  const configured = getDocsFeedbackDb(env);
  if (!configured) {
    return {
      feedback: seedDocsFeedback.map((feedback) => ({
        ...feedback,
        authorEmail: null
      })),
      persisted: false,
      storageBinding: null
    };
  }

  await ensureDocsFeedbackSchema(configured.db);
  const response = await configured.db
    .prepare(
      `SELECT
        id,
        kind,
        topic,
        author_name,
        author_email,
        message,
        status,
        answer_text,
        answered_by,
        answered_at,
        created_at
      FROM docs_feedback
      ORDER BY
        CASE status WHEN 'pending' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 50`
    )
    .all<DocsFeedbackRow>();

  return {
    feedback: (response.results ?? []).map(mapAdminDocsFeedbackRow),
    persisted: true,
    storageBinding: configured.binding
  };
}

export async function submitDocsFeedback(
  env: DocsFeedbackEnv,
  input: DocsFeedbackSubmission
): Promise<DocsFeedbackMutationResult> {
  const validation = validateFeedback(input);
  if (!validation.ok) {
    return validation;
  }

  const now = new Date().toISOString();
  const feedback = {
    id: `docs-${crypto.randomUUID()}`,
    kind: validation.value.kind,
    topic: validation.value.topic,
    authorName: validation.value.authorName,
    message: validation.value.message,
    status: "pending",
    answerText: undefined,
    answeredBy: undefined,
    answeredAt: undefined,
    createdAt: now
  } satisfies PublicDocsFeedback;

  const configured = getDocsFeedbackDb(env);
  if (!configured) {
    return {
      ok: true,
      feedback,
      persisted: false,
      storageBinding: null
    };
  }

  await ensureDocsFeedbackSchema(configured.db);
  await configured.db
    .prepare(
      `INSERT INTO docs_feedback (
        id,
        kind,
        topic,
        author_name,
        author_email,
        message,
        status,
        answer_text,
        answered_by,
        answered_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      feedback.id,
      feedback.kind,
      feedback.topic,
      feedback.authorName,
      validation.value.authorEmail || null,
      feedback.message,
      feedback.status,
      null,
      null,
      null,
      feedback.createdAt
    )
    .run();

  return {
    ok: true,
    feedback,
    persisted: true,
    storageBinding: configured.binding
  };
}

export async function updateDocsFeedbackReview(
  env: DocsFeedbackEnv,
  id: string,
  input: DocsFeedbackReviewInput,
  actorEmail: string
): Promise<DocsFeedbackMutationResult> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return {
      ok: false,
      status: 400,
      code: "docs_feedback_id_required",
      message: "Docs feedback id is required."
    };
  }

  if (
    input.status !== undefined &&
    input.status !== "approved" &&
    input.status !== "pending"
  ) {
    return {
      ok: false,
      status: 400,
      code: "invalid_docs_feedback_status",
      message: "Docs feedback status must be approved or pending."
    };
  }

  const configured = getDocsFeedbackDb(env);
  if (!configured) {
    return {
      ok: false,
      status: 409,
      code: "storage_not_configured",
      message: "Cloudflare D1 binding ODAP_GATEWAY_DB is required for this action."
    };
  }

  await ensureDocsFeedbackSchema(configured.db);
  const existing = await getAdminDocsFeedback(configured.db, normalizedId);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      code: "docs_feedback_not_found",
      message: "Docs feedback item was not found."
    };
  }

  const answerChanged = input.answerText !== undefined;
  const answerText = answerChanged
    ? normalizeText(input.answerText ?? "", MAX_ANSWER_LENGTH)
    : existing.answerText ?? "";
  const answeredBy = answerChanged
    ? answerText
      ? actorEmail.toLowerCase()
      : ""
    : existing.answeredBy ?? "";
  const answeredAt = answerChanged
    ? answerText
      ? new Date().toISOString()
      : ""
    : existing.answeredAt ?? "";
  const status = input.status ?? existing.status;

  await configured.db
    .prepare(
      `UPDATE docs_feedback
      SET
        status = ?,
        answer_text = ?,
        answered_by = ?,
        answered_at = ?
      WHERE id = ?`
    )
    .bind(
      status,
      answerText || null,
      answerText ? answeredBy : null,
      answerText ? answeredAt : null,
      normalizedId
    )
    .run();

  return {
    ok: true,
    feedback: {
      ...existing,
      status,
      answerText: answerText || undefined,
      answeredBy: answerText ? answeredBy : undefined,
      answeredAt: answerText ? answeredAt : undefined
    },
    persisted: true,
    storageBinding: configured.binding
  };
}

export async function ensureDocsFeedbackSchema(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS docs_feedback (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        topic TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        answer_text TEXT,
        answered_by TEXT,
        answered_at TEXT,
        created_at TEXT NOT NULL
      )`
    )
    .run();

  await addColumnIfMissing(db, "ALTER TABLE docs_feedback ADD COLUMN answer_text TEXT");
  await addColumnIfMissing(db, "ALTER TABLE docs_feedback ADD COLUMN answered_by TEXT");
  await addColumnIfMissing(db, "ALTER TABLE docs_feedback ADD COLUMN answered_at TEXT");

  await Promise.all(
    seedDocsFeedback.map((feedback) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO docs_feedback (
            id,
            kind,
            topic,
            author_name,
            author_email,
            message,
            status,
            answer_text,
            answered_by,
            answered_at,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          feedback.id,
          feedback.kind,
          feedback.topic,
          feedback.authorName,
          null,
          feedback.message,
          feedback.status,
          feedback.answerText ?? null,
          feedback.answeredBy ?? null,
          feedback.answeredAt ?? null,
          feedback.createdAt
        )
        .run()
    )
  );
}

async function addColumnIfMissing(db: D1Database, query: string) {
  try {
    await db.prepare(query).run();
  } catch {
    // Existing D1 databases already have the column; SQLite rejects duplicates.
  }
}

function getDocsFeedbackDb(env: DocsFeedbackEnv) {
  if (env.ODAP_GATEWAY_DB) {
    return {
      db: env.ODAP_GATEWAY_DB,
      binding: "ODAP_GATEWAY_DB" as const
    };
  }

  if (env.DB) {
    return {
      db: env.DB,
      binding: "DB" as const
    };
  }

  return null;
}

function validateFeedback(
  input: DocsFeedbackSubmission
):
  | {
      ok: true;
      value: DocsFeedbackSubmission;
    }
  | {
      ok: false;
      status: 400;
      code: string;
      message: string;
    } {
  const kind = input.kind;
  const topic = normalizeText(input.topic, MAX_TOPIC_LENGTH);
  const authorName =
    normalizeText(input.authorName, MAX_NAME_LENGTH) || "Anonymous";
  const authorEmail = normalizeText(input.authorEmail, MAX_EMAIL_LENGTH);
  const message = normalizeText(input.message, MAX_MESSAGE_LENGTH);

  if (kind !== "comment" && kind !== "question") {
    return {
      ok: false,
      status: 400,
      code: "invalid_feedback_kind",
      message: "Feedback kind must be comment or question."
    };
  }

  if (!topic) {
    return {
      ok: false,
      status: 400,
      code: "feedback_topic_required",
      message: "A topic is required."
    };
  }

  if (!message || message.length < 12) {
    return {
      ok: false,
      status: 400,
      code: "feedback_message_required",
      message: "Message must be at least 12 characters."
    };
  }

  if (authorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_author_email",
      message: "Use a valid email address or leave it empty."
    };
  }

  return {
    ok: true,
    value: {
      kind,
      topic,
      authorName,
      authorEmail,
      message
    }
  };
}

function normalizeText(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function mapDocsFeedbackRow(row: DocsFeedbackRow): PublicDocsFeedback {
  return {
    id: row.id,
    kind: row.kind,
    topic: row.topic,
    authorName: row.author_name,
    message: row.message,
    status: row.status,
    answerText: row.answer_text ?? undefined,
    answeredBy: row.answered_by ?? undefined,
    answeredAt: row.answered_at ?? undefined,
    createdAt: row.created_at
  };
}

function mapAdminDocsFeedbackRow(row: DocsFeedbackRow): AdminDocsFeedback {
  return {
    ...mapDocsFeedbackRow(row),
    authorEmail: row.author_email
  };
}

async function getAdminDocsFeedback(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT
        id,
        kind,
        topic,
        author_name,
        author_email,
        message,
        status,
        answer_text,
        answered_by,
        answered_at,
        created_at
      FROM docs_feedback
      WHERE id = ?`
    )
    .bind(id)
    .first<DocsFeedbackRow>();

  return row ? mapAdminDocsFeedbackRow(row) : null;
}
