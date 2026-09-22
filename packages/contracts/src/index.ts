import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
export type { ContractTypes } from './generated';

// The canonical contract remains the only runtime schema and code-generation input.
export const bundle = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../packages/contracts/schema.json'), 'utf8'),
);
export const toolDefinitions: {
  name: string;
  description: string;
  input_ref: string;
  output_ref: string;
  read_only: boolean;
}[] = bundle['x-mcp-tools'];
export const stateModel: {
  terminal: string[];
  transitions: { from: string; to: string }[];
  submission_transitions: { from: string; to: string }[];
} = bundle['x-state-model'];
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(bundle);
export function schema(ref: string) {
  return {
    $schema: bundle.$schema,
    ...structuredClone(bundle.$defs[ref.replace('#/$defs/', '')]),
    $defs: structuredClone(bundle.$defs),
  };
}
export function validDefinition(name: string, value: unknown): boolean {
  return !!ajv.validate(`${bundle.$id}#/$defs/${name}`, value);
}
export function validTool(name: string, direction: 'input' | 'output', payload: unknown): boolean {
  return !!ajv.validate(bundle.$id, { tool: name, direction, payload });
}
