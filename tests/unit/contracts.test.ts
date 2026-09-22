import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

test('canonical JSON Schema 2020-12 validates all supplied valid and invalid examples', () => {
  const contract = JSON.parse(readFileSync(path.resolve('packages/contracts/schema.json'), 'utf8'));
  const examples = JSON.parse(
    readFileSync(path.resolve('tests/fixtures/contract-examples.json'), 'utf8'),
  );
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  assert.equal(ajv.validateSchema(contract), true);
  const validate = ajv.compile(contract);
  for (const sample of examples.cases) {
    assert.equal(
      validate({ tool: sample.tool, direction: sample.direction, payload: sample.payload }),
      sample.valid,
      `${sample.name}: ${JSON.stringify(validate.errors)}`,
    );
  }
  assert.equal(examples.cases.length, 96);
});
