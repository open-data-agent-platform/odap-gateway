import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("page indexing policy", () => {
  it("keeps every explicit page robots declaration indexable", () => {
    const app = resolve("app");
    const files = readdirSync(app, { recursive: true, withFileTypes: true })
      .filter(file => file.isFile() && /^(page|layout)\.tsx$/.test(file.name));
    const checked: string[] = [];
    for (const file of files) {
      const path = resolve(file.parentPath, file.name);
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === "metadata" && node.initializer) {
          expect(ts.isObjectLiteralExpression(node.initializer), path).toBe(true);
          if (!ts.isObjectLiteralExpression(node.initializer)) return;
          const robots = node.initializer.properties.find(property =>
            ts.isPropertyAssignment(property) && property.name.getText(source) === "robots");
          if (robots && ts.isPropertyAssignment(robots)) {
            expect(ts.isObjectLiteralExpression(robots.initializer), path).toBe(true);
            if (!ts.isObjectLiteralExpression(robots.initializer)) return;
            for (const name of ["index", "follow"]) {
              const rule = robots.initializer.properties.find(property =>
                ts.isPropertyAssignment(property) && property.name.getText(source) === name);
              expect(rule && ts.isPropertyAssignment(rule) && rule.initializer.kind === ts.SyntaxKind.TrueKeyword,
                path + " " + name).toBe(true);
            }
            checked.push(path);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(checked).toContain(resolve(app, "layout.tsx"));
  });
});
