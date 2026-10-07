import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import validator from 'gltf-validator';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../m3d');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
let failed = false;
for (const [key, rec] of Object.entries(manifest.maps)) {
  const result = await validator.validateBytes(fs.readFileSync(path.join(root, rec.file)), { uri: rec.file, maxIssues: 50 });
  console.log(JSON.stringify({ key, ...result.issues }));
  failed ||= result.issues.numErrors > 0;
}
process.exitCode = failed ? 1 : 0;
