export type D1Value = string | number | boolean | null | ArrayBuffer;

export type D1Result<T = Record<string, D1Value>> = {
  results?: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
};

export type D1PreparedStatement = {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, D1Value>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, D1Value>>(): Promise<D1Result<T>>;
  run<T = Record<string, D1Value>>(): Promise<D1Result<T>>;
};

export type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec?(query: string): Promise<D1Result>;
};
