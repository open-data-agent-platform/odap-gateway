export type SchemaField = {
  name: string;
  type: "INT64" | "DATE" | "STRING" | "FLOAT64" | "TIMESTAMP" | "STRUCT" | "ARRAY";
  key?: boolean;
};

export type SchemaTable = {
  name: string;
  columnCount: number;
  fields: SchemaField[];
};

export const schemaTables: SchemaTable[] = [
  {
    name: "demo.orders",
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
    name: "demo.customers",
    columnCount: 9,
    fields: [
      { name: "customer_id", type: "INT64", key: true },
      { name: "created_at", type: "TIMESTAMP" },
      { name: "plan", type: "STRING" },
      { name: "country", type: "STRING" }
    ]
  },
  {
    name: "demo.events",
    columnCount: 16,
    fields: [
      { name: "event_time", type: "TIMESTAMP" },
      { name: "event_name", type: "STRING" },
      { name: "actor_ref", type: "STRING" },
      { name: "session_ref", type: "STRING" }
    ]
  }
];
