import { Parser } from "node-sql-parser/build/bigquery";

type ObjectNode = Record<string, unknown>;
export type PreviewSqlReferences = {
  table: string;
  columns: string[];
  selectedColumns: string[];
  selectedStar: boolean;
};

const scalarFunctions = new Set([
  "ABS", "CEIL", "FLOOR", "ROUND", "COALESCE", "IF", "IFNULL", "NULLIF",
  "CURRENT_DATE", "CURRENT_TIMESTAMP", "DATE", "DATE_SUB", "DATE_ADD", "DATE_TRUNC",
  "TIMESTAMP", "TIMESTAMP_SUB", "TIMESTAMP_ADD", "TIMESTAMP_TRUNC", "JSON_QUERY", "JSON_VALUE"
]);
const aggregates = new Set(["COUNT", "COUNTIF", "SUM", "AVG", "MIN", "MAX"]);
const literals = new Set(["number", "single_quote_string", "double_quote_string", "bool", "null", "date", "timestamp"]);
const binaryOperators = new Set(["+", "-", "*", "/", "%", "=", "!=", "<>", ">", "<", ">=", "<=",
  "AND", "OR", "IS", "IS NOT", "IN", "NOT IN", "BETWEEN", "NOT BETWEEN", "LIKE", "NOT LIKE"]);

function object(value: unknown): value is ObjectNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function node(value: unknown, keys: string[]): ObjectNode {
  if (!object(value) || Object.keys(value).some(key => value[key] !== undefined && !keys.includes(key))) throw new Error("Unsupported SQL shape");
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("Unsupported identifier");
  return value.toLowerCase();
}
function absent(value: unknown) {
  if (value !== undefined && value !== null) throw new Error("Unsupported SQL feature");
}
function empty(value: unknown) {
  if (value !== undefined && (!Array.isArray(value) || value.length)) throw new Error("Unsupported nested reference");
}

// This is a deliberately restricted preview profile, not production authorization.
// Unrecognized AST shapes never fall back to regex or partially collected names.
export function analyzePreviewSql(sql: string): PreviewSqlReferences | null {
  if (!sql.trim() || sql.length > 20_000) return null;
  try {
    const parsed: unknown = new Parser().astify(sql);
    const statement = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    const root = node(statement, ["type", "as_struct_val", "distinct", "columns", "from", "for_sys_time_as_of",
      "where", "with", "groupby", "having", "qualify", "orderby", "limit", "window", "_orderby", "_limit"]);
    if (root.type !== "select" || (root.distinct !== null && root.distinct !== "DISTINCT")) return null;
    for (const key of ["as_struct_val", "for_sys_time_as_of", "with", "qualify", "window", "_orderby", "_limit"]) absent(root[key]);
    if (!Array.isArray(root.from) || root.from.length !== 1) return null;
    const from = node(root.from[0], ["db", "table", "surround", "as", "operator"]);
    absent(from.operator);
    if (typeof from.table !== "string" || (from.db !== null && typeof from.db !== "string")) return null;
    const table = [from.db, from.table].filter(Boolean).join(".");
    const parts = table.split(".");
    if (parts.length < 2 || parts.length > 3 || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(parts[0])) return null;
    parts.slice(1).forEach(identifier);
    const qualifier = from.as === null ? identifier(parts.at(-1)) : identifier(from.as);
    const columns = new Set<string>(), selectedColumns = new Set<string>(), aliases = new Set<string>();
    let selectedStar = false, visited = 0;
    const visit = (value: unknown, selected: boolean, allowAlias = false, depth = 0, allowStar = false): void => {
      if (++visited > 2048 || depth > 32 || !object(value)) throw new Error("Unsupported expression");
      const next = (child: unknown) => visit(child, selected, allowAlias, depth + 1);
      switch (value.type) {
        case "column_ref": {
          const ref = node(value, ["type", "table", "column", "subFields", "collate"]);
          empty(ref.subFields); absent(ref.collate);
          if (ref.table !== null && identifier(ref.table) !== qualifier) throw new Error("Unknown qualifier");
          let name = ref.column;
          if (object(name)) {
            const column = node(name, ["expr", "offset"]), expr = node(column.expr, ["type", "value"]);
            empty(column.offset);
            if (expr.type !== "default" && expr.type !== "backticks_quote_string") throw new Error("Unsupported column");
            name = expr.value;
          }
          if (name === "*" && allowStar) { selectedStar = true; return; }
          const normalized = identifier(name);
          if (ref.table === null && allowAlias && aliases.has(normalized)) return;
          if (ref.table === null && normalized === qualifier) throw new Error("Whole-row reference unsupported");
          columns.add(normalized);
          if (selected) selectedColumns.add(normalized);
          return;
        }
        case "binary_expr": {
          const expr = node(value, ["type", "operator", "left", "right", "parentheses"]);
          if (!binaryOperators.has(String(expr.operator).toUpperCase())) throw new Error("Unsupported operator");
          next(expr.left); next(expr.right); return;
        }
        case "unary_expr": {
          const expr = node(value, ["type", "operator", "expr", "parentheses"]);
          if (!["+", "-", "NOT"].includes(String(expr.operator).toUpperCase())) throw new Error("Unsupported unary expression");
          next(expr.expr); return;
        }
        case "expr_list": {
          const expr = node(value, ["type", "value", "parentheses"]);
          if (!Array.isArray(expr.value)) throw new Error("Unsupported list");
          expr.value.forEach(next); return;
        }
        case "aggr_func": {
          const expr = node(value, ["type", "name", "args", "over", "parentheses"]);
          absent(expr.over);
          const name = String(expr.name).toUpperCase();
          if (!aggregates.has(name)) throw new Error("Unsupported aggregate");
          const args = node(expr.args, ["expr", "distinct", "orderby"]);
          absent(args.orderby);
          if (args.distinct !== undefined && args.distinct !== null && args.distinct !== "DISTINCT") throw new Error("Unsupported aggregate arguments");
          if (name === "COUNT" && object(args.expr) && args.expr.type === "star") {
            const star = node(args.expr, ["type", "value"]);
            if (star.value !== "*" || args.distinct === "DISTINCT") throw new Error("Unsupported count");
            return;
          }
          // Aggregate arguments refer to input fields, never projection aliases.
          visit(args.expr, selected, false, depth + 1); return;
        }
        case "function": {
          const expr = node(value, ["type", "name", "args", "over", "parentheses"]);
          absent(expr.over);
          const name = node(expr.name, ["name", "schema"]);
          if (!Array.isArray(name.name)) throw new Error("Unsupported function");
          const components = [...name.name, ...(name.schema ? [name.schema] : [])];
          if (components.length !== 1) throw new Error("Qualified functions unsupported");
          const component = node(components[0], ["type", "value"]);
          if (component.type !== "default" || !scalarFunctions.has(String(component.value).toUpperCase())) throw new Error("Unsupported function");
          next(expr.args); return;
        }
        case "interval": {
          const expr = node(value, ["type", "expr", "unit"]);
          if (typeof expr.unit !== "string") throw new Error("Unsupported interval");
          next(expr.expr); return;
        }
        case "extract": {
          const expr = node(value, ["type", "args"]), args = node(expr.args, ["field", "source"]);
          if (typeof args.field !== "string") throw new Error("Unsupported extract");
          next(args.source); return;
        }
        case "cast": {
          const expr = node(value, ["type", "keyword", "expr", "symbol", "target", "parentheses"]);
          if (!["cast", "safe_cast"].includes(String(expr.keyword).toLowerCase()) || !Array.isArray(expr.target) || expr.target.length !== 1) throw new Error("Unsupported cast");
          const target = node(expr.target[0], ["dataType"]);
          if (!["STRING", "BOOL", "INT64", "FLOAT64", "NUMERIC", "DATE", "TIMESTAMP"].includes(String(target.dataType).toUpperCase())) throw new Error("Unsupported cast target");
          next(expr.expr); return;
        }
        case "case": {
          const expr = node(value, ["type", "expr", "args", "parentheses"]);
          if (expr.expr !== null) next(expr.expr);
          if (!Array.isArray(expr.args)) throw new Error("Unsupported case");
          for (const item of expr.args) {
            const arm = node(item, ["type", "cond", "result"]);
            if (arm.type === "when") next(arm.cond);
            else if (arm.type !== "else" || arm.cond !== undefined) throw new Error("Unsupported case arm");
            next(arm.result);
          }
          return;
        }
        default: {
          if (!literals.has(String(value.type))) throw new Error("Unsupported expression type");
          const literal = node(value, ["type", "value", "parentheses"]);
          if (literal.value !== null && !["string", "number", "boolean"].includes(typeof literal.value)) throw new Error("Unsupported literal");
        }
      }
    };
    if (!Array.isArray(root.columns) || !root.columns.length) return null;
    for (const value of root.columns) {
      const column = node(value, ["expr", "as"]);
      // Projection aliases never hide source columns in that projection or WHERE.
      visit(column.expr, true, false, 0, true);
      if (column.as !== null) {
        const alias = identifier(column.as);
        if (aliases.has(alias)) return null;
        aliases.add(alias);
      }
    }
    if (root.where !== null) visit(root.where, false);
    if (root.groupby !== null) {
      const group = node(root.groupby, ["columns"]);
      if (!Array.isArray(group.columns)) return null;
      group.columns.forEach(value => visit(value, false, true));
    }
    if (root.having !== null) visit(root.having, false, true);
    if (root.orderby !== null) {
      if (!Array.isArray(root.orderby)) return null;
      for (const value of root.orderby) {
        const order = node(value, ["expr", "type"]);
        if (order.type !== null && !["ASC", "DESC"].includes(String(order.type))) return null;
        visit(order.expr, false, true);
      }
    }
    if (root.limit !== null) {
      const limit = node(root.limit, ["seperator", "value"]);
      if (limit.seperator !== "" || !Array.isArray(limit.value) || limit.value.length !== 1 || !object(limit.value[0]) || limit.value[0].type !== "number" ||
          !Number.isSafeInteger(limit.value[0].value) || Number(limit.value[0].value) < 0) return null;
      node(limit.value[0], ["type", "value"]);
    }
    return { table, columns: [...columns], selectedColumns: [...selectedColumns], selectedStar };
  } catch {
    return null;
  }
}
