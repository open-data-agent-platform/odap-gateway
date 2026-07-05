export type SchemaField = {
  name: string;
  type: "INT64" | "DATE" | "STRING" | "FLOAT64" | "TIMESTAMP";
  key?: boolean;
};

export type SchemaTable = {
  name: string;
  columnCount: number;
  fields: SchemaField[];
};

export const schemaTables: SchemaTable[] = [
  {
    name: "analytics.orders",
    columnCount: 12,
    fields: [
      { name: "order_id", type: "INT64", key: true },
      { name: "order_date", type: "DATE" },
      { name: "acquisition_channel", type: "STRING" },
      { name: "revenue", type: "FLOAT64" },
      { name: "status", type: "STRING" },
      { name: "customer_id", type: "INT64" }
    ]
  },
  {
    name: "analytics.customers",
    columnCount: 9,
    fields: [
      { name: "customer_id", type: "INT64", key: true },
      { name: "created_at", type: "TIMESTAMP" },
      { name: "plan", type: "STRING" },
      { name: "country", type: "STRING" }
    ]
  },
  {
    name: "analytics.events",
    columnCount: 16,
    fields: [
      { name: "event_time", type: "TIMESTAMP" },
      { name: "event_name", type: "STRING" },
      { name: "user_id", type: "STRING" },
      { name: "session_id", type: "STRING" }
    ]
  }
];

export const tutorials = [
  {
    title: "Date Bucketing in SQL",
    level: "Beginner",
    summary:
      "Use DATE_TRUNC, EXTRACT, and calendar-safe filters for weekly and monthly reporting."
  },
  {
    title: "Window Functions for Analysts",
    level: "Intermediate",
    summary:
      "Rank rows, compute running totals, and compare current rows to prior periods."
  },
  {
    title: "Safer BigQuery Cost Patterns",
    level: "Practical",
    summary:
      "Reduce scanned bytes with partitions, selected columns, and bounded date filters."
  },
  {
    title: "Working with Arrays",
    level: "Intermediate",
    summary:
      "Use UNNEST and ARRAY_AGG for nested BigQuery records without losing row meaning."
  },
  {
    title: "JSON in SQL",
    level: "Practical",
    summary:
      "Extract typed fields from JSON columns and keep parsing logic reviewable."
  },
  {
    title: "Query Review Checklist",
    level: "Team",
    summary:
      "A repeatable checklist for validating generated SQL before execution."
  }
];

export const cheatSheets = [
  {
    title: "Dates",
    items: [
      "DATE_TRUNC(order_date, MONTH)",
      "DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)",
      "EXTRACT(ISOWEEK FROM order_date)"
    ]
  },
  {
    title: "Arrays",
    items: [
      "CROSS JOIN UNNEST(items) AS item",
      "ARRAY_AGG(product_id ORDER BY revenue DESC)",
      "ARRAY_LENGTH(event_params)"
    ]
  },
  {
    title: "Windows",
    items: [
      "ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at)",
      "SUM(revenue) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)",
      "LAG(revenue) OVER (PARTITION BY channel ORDER BY week)"
    ]
  },
  {
    title: "JSON",
    items: [
      "JSON_VALUE(payload, '$.campaign')",
      "SAFE_CAST(JSON_VALUE(payload, '$.amount') AS NUMERIC)",
      "JSON_QUERY(payload, '$.items')"
    ]
  }
];
