import { join } from 'node:path';
import { writeReleaseFiles } from './release-writer.ts';

const version = await writeReleaseFiles(
  join(import.meta.dirname, '..'),
  process.argv[2] ?? '',
  process.env['GITHUB_OUTPUT'],
);
console.log(`Wrote the notes and fingerprints of Tasklace ${version}.`);
