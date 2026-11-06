import type { D1Database, D1Value } from "./d1";
import type { AuthSession } from "./auth";
import { ensureAdminSchema } from "./admin-store";
import type {
  DocsFeedbackKind,
  DocsFeedbackStatus,
  PublicDocsFeedback
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
      status: 400 | 403 | 404 | 409 | 500 | 503;
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
      feedback: [],
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
  if (response.success !== true || !Array.isArray(response.results)) {
    throw new Error("Feedback read not confirmed");
  }
  const rows = response.results.map(mapDocsFeedbackRow);

  return {
    feedback: rows,
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
      feedback: [],
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

  if (response.success !== true || !Array.isArray(response.results)) {
    throw new Error("Feedback read not confirmed");
  }
  return {
    feedback: response.results.map(mapAdminDocsFeedbackRow),
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

  const configured = getDocsFeedbackDb(env);
  if (!configured) {
    return {
      ok: false,
      status: 503,
      code: "docs_feedback_storage_unavailable",
      message: "Feedback requires configured database storage. Nothing was submitted."
    };
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

  await ensureDocsFeedbackSchema(configured.db);
  const inserted = await configured.db
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
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
    .first<{ id: string }>();
  if (inserted?.id !== feedback.id) {
    throw new Error("Feedback submission not confirmed");
  }

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
  actor: Pick<AuthSession, "provider" | "providerId" | "email">
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

  if (!configured.db.batch) {
    return {
      ok: false,
      status: 503,
      code: "docs_feedback_transaction_unavailable",
      message: "Transactional storage is required for feedback review."
    };
  }

  await ensureAdminSchema(configured.db);
  await ensureDocsFeedbackSchema(configured.db);
  const existing = await getDocsFeedbackRow(configured.db, normalizedId);
  if (!existing) {
    return {
      ok: false,
      status: 404,
      code: "docs_feedback_not_found",
      message: "Docs feedback item was not found."
    };
  }

  const now = new Date().toISOString();
  const answerChanged = input.answerText !== undefined;
  const answerText = answerChanged
    ? normalizeText(input.answerText ?? "", MAX_ANSWER_LENGTH)
    : existing.answer_text ?? "";
  const answeredBy = answerChanged
    ? answerText
      ? actor.email.toLowerCase()
      : ""
    : existing.answered_by ?? "";
  const answeredAt = answerChanged
    ? answerText
      ? now
      : ""
    : existing.answered_at ?? "";
  const status = input.status ?? existing.status;
  const auditId = crypto.randomUUID();
  const metadata = {
    previousStatus: existing.status,
    previousAnswered: Boolean(existing.answer_text),
    status,
    answered: Boolean(answerText),
    answerChanged: answerText !== (existing.answer_text ?? "")
  };
  const guard = `id = ? AND kind = ? AND topic = ? AND author_name = ?
    AND author_email IS ? AND message = ? AND status = ? AND answer_text IS ?
    AND answered_by IS ? AND answered_at IS ? AND created_at = ?
    AND EXISTS (SELECT 1 FROM users AS actor WHERE actor.id = ?
      AND actor.provider = ? AND actor.provider_id = ? AND actor.role = 'admin' AND actor.email = ?)`;
  const guardedValues: D1Value[] = [
    existing.id, existing.kind, existing.topic, existing.author_name, existing.author_email,
    existing.message, existing.status, existing.answer_text, existing.answered_by,
    existing.answered_at, existing.created_at,
    `${actor.provider}:${actor.providerId}`, actor.provider, actor.providerId, actor.email
  ];
  const results = await configured.db.batch([
    configured.db.prepare(
      `INSERT INTO audit_events (id, actor_email, action, target, metadata_json, created_at)
      SELECT ?, ?, 'docs_feedback.reviewed', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM docs_feedback WHERE ${guard})
        OR EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
      RETURNING id`
    ).bind(auditId, actor.email.toLowerCase(), normalizedId, JSON.stringify(metadata), now,
      ...guardedValues, auditId),
    configured.db.prepare(
      `UPDATE docs_feedback
      SET
        status = ?,
        answer_text = ?,
        answered_by = ?,
        answered_at = ?
      WHERE ${guard} AND changes() = 1 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
      RETURNING id, kind, topic, author_name, author_email, message, status,
        answer_text, answered_by, answered_at, created_at`
    )
    .bind(
      status,
      answerText || null,
      answerText ? answeredBy : null,
      answerText ? answeredAt : null,
      ...guardedValues,
      auditId
    ),
    // Roll back a skipped update instead of leaving its audit committed. Never
    // delete audit history, even if a colliding insertion was itself ignored.
    configured.db.prepare(
      `SELECT CASE WHEN changes() = 0 AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
        THEN abs(-9223372036854775808) ELSE 1 END AS confirmed`
    ).bind(auditId)
  ]);
  if (results.length !== 3 || results.some(result => result.success !== true || !Array.isArray(result.results))) {
    throw new Error("Feedback review transaction not confirmed");
  }
  const updated = results[1].results?.[0] as DocsFeedbackRow | undefined;
  if (!updated) {
    return {
      ok: false,
      status: 403,
      code: "docs_feedback_review_denied",
      message: "Administrator authority or the inspected feedback changed. Refresh before retrying."
    };
  }
  if (results[0].results?.length !== 1 || results[2].results?.[0]?.confirmed !== 1) {
    throw new Error("Feedback review audit not confirmed");
  }

  return {
    ok: true,
    feedback: mapAdminDocsFeedbackRow(updated),
    persisted: true,
    storageBinding: configured.binding
  };
}

export async function ensureDocsFeedbackSchema(db: D1Database) {
  const created = await db
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
  if (created.success !== true) throw new Error("Feedback table creation not confirmed");

  const baseColumns = ["id", "kind", "topic", "author_name", "author_email", "message", "status", "created_at"];
  const answerColumns = ["answer_text", "answered_by", "answered_at"];
  const columns = await readDocsFeedbackColumns(db);
  if (baseColumns.some(name => !columns.has(name))) throw new Error("Feedback base schema not confirmed");
  const missing = answerColumns.filter(name => !columns.has(name));
  for (const name of missing) {
    // Names come only from this fixed list. Any failure, including a concurrent
    // duplicate addition, stops this request; later requests inspect afresh.
    const added = await db.prepare(`ALTER TABLE docs_feedback ADD COLUMN ${name} TEXT`).run();
    if (added.success !== true) throw new Error("Feedback column addition not confirmed");
  }
  if (missing.length > 0) {
    const updated = await readDocsFeedbackColumns(db);
    if ([...baseColumns, ...answerColumns].some(name => !updated.has(name))) {
      throw new Error("Feedback schema upgrade not confirmed");
    }
  }
}

async function readDocsFeedbackColumns(db: D1Database): Promise<Set<string>> {
  const result = await db.prepare("PRAGMA table_info(docs_feedback)").all<{ name: unknown }>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length === 0) {
    throw new Error("Feedback schema inspection not confirmed");
  }
  const names = new Set<string>();
  for (const row of result.results) {
    if (!row || typeof row.name !== "string" || !row.name.trim() || names.has(row.name.toLowerCase())) {
      throw new Error("Feedback schema inspection not confirmed");
    }
    names.add(row.name.toLowerCase());
  }
  return names;
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

async function getDocsFeedbackRow(db: D1Database, id: string) {
  return db
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
}
