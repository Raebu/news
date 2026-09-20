import { readFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"));
if (spec.openapi !== "3.1.0") throw new Error("OpenAPI version must be 3.1.0.");
const required = [
  ["GET", "/healthz"], ["GET", "/readyz"], ["GET", "/version"],
  ["GET", "/articles"], ["GET", "/articles/{slug}"],
  ["POST", "/publish"], ["POST", "/api/newsroom/signals"]
];
for (const [method, path] of required) {
  if (!spec.paths?.[path]?.[method.toLowerCase()]) throw new Error(`OpenAPI missing ${method} ${path}`);
}
for (const path of ["/articles","/articles/{slug}","/publish","/api/newsroom/signals"]) {
  const operation = spec.paths[path][path === "/articles" || path === "/articles/{slug}" ? "get" : "post"];
  if (!Array.isArray(operation.security) || operation.security.length === 0) {
    throw new Error(`OpenAPI missing service authentication on ${path}`);
  }
}
if (!spec.components?.securitySchemes?.serviceKey) throw new Error("OpenAPI missing serviceKey security scheme.");
process.stdout.write("Validated OpenAPI contract and protected-route security declarations.\n");
