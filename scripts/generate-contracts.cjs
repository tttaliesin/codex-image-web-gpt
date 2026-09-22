const { compile } = require('json-schema-to-typescript');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
async function main() {
  const bundle = JSON.parse(readFileSync('packages/contracts/schema.json', 'utf8'));
  const names = Object.keys(bundle.$defs);
  const source = await compile(
    {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(names.map((name) => [name, { $ref: `#/$defs/${name}` }])),
      required: names,
      $defs: bundle.$defs,
    },
    'ContractTypes',
    {
      bannerComment: '/* Generated from packages/contracts/schema.json. Do not edit. */',
      unreachableDefinitions: true,
      format: true,
      maxItems: -1,
    },
  );
  const target = 'packages/contracts/src/generated.ts';
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== source) throw Error('Generated contract types are stale');
  } else {
    mkdirSync('packages/contracts/src', { recursive: true });
    writeFileSync(target, source);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
