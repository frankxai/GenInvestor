import type { PolicyTable } from "./policy.ts";
import policy from "../../contracts/policy/policy.json" with { type: "json" };
import datum from "../../contracts/schemas/datum.schema.json" with { type: "json" };
import claim from "../../contracts/schemas/claim.schema.json" with { type: "json" };
import brief from "../../contracts/schemas/brief.schema.json" with { type: "json" };
import mandate from "../../contracts/schemas/mandate.schema.json" with { type: "json" };
import opportunities from "../../contracts/schemas/opportunities.schema.json" with { type: "json" };
const schemas: Record<string, Record<string, unknown>> = { datum, claim, brief, mandate, opportunities };
export function loadPolicyTable(): PolicyTable { return structuredClone(policy) as PolicyTable; }
export function loadSchema(name: string): Record<string, unknown> {
 const schema = schemas[name]; if (!schema) throw Error("Unknown evidence schema");
 return structuredClone(schema);
}
