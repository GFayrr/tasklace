import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pngSize, readIco } from '../../scripts/ico-file.ts';
import { checkRelease } from '../../scripts/release-files.ts';
import { APPLICATION_USER_MODEL_ID } from '../../src/main/platform/application-identity';

const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const WINDOW_ICON_SIZE = 256;
const ARTIFACT_EXTENSIONS = { amd64: 'deb', x86_64: 'rpm', portable: 'exe', setup: 'exe' } as const;
const RELEASE_JOBS = [['build-linux', 'build-windows'], ['collect'], ['draft']] as const;
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

interface PackageFile {
  readonly productName: unknown;
  readonly version: unknown;
}

/** Reads the package file of the application. */
function packageFile(): PackageFile {
  return JSON.parse(readFileSync('package.json', 'utf8')) as PackageFile;
}

/** Gives the names electron-builder gives the built files of a version. */
function builtNames(version: string): readonly string[] {
  const settings = readFileSync('electron-builder.yml', 'utf8');
  return [...settings.matchAll(/artifactName: (\S+)/g)].map((match) => {
    const name = String(match[1]);
    const extension = Object.entries(ARTIFACT_EXTENSIONS).find(([kind]) =>
      name.includes(`-${kind}.`),
    )?.[1];
    if (extension === undefined) {
      throw new Error(`No extension is known for the built file ${name}.`);
    }
    return name.replace('${version}', version).replace('${ext}', extension);
  });
}

/** Gives the text of each job of the release workflow, by name. */
function releaseJobs(): ReadonlyMap<string, string> {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n')).split(/^ {2}(?=[\w-]+:$)/m);
  return new Map(jobs.slice(1).map((job) => [job.slice(0, job.indexOf(':')), job]));
}

/** Gives the patterns of built files that some jobs of the release workflow upload, one a line, or publish. */
function patternsOfJobs(names: readonly string[]): readonly RegExp[] {
  const jobs = releaseJobs();
  const globs = names.flatMap((name) => {
    const job = jobs.get(name);
    if (job === undefined) {
      throw new Error(`The release workflow has no job ${name}.`);
    }
    return [...job.matchAll(/^\s+dist\/(Tasklace-\S+)$|release\/(Tasklace-[^\s\\]+)/gm)].map(
      ([, uploaded, published]) => String(uploaded ?? published),
    );
  });
  return globs.map(
    (glob) => new RegExp(`^${glob.replaceAll('.', String.raw`\.`).replaceAll('*', '.*')}$`),
  );
}

describe('release files', () => {
  it.each([16, 24, 32, 48, 64, 128, 256, 512])(
    'ships a Linux icon of %i pixels that is a PNG of that size',
    (size) => {
      const file = `build/icons/linux/${String(size)}x${String(size)}.png`;
      expect(pngSize(new Uint8Array(readFileSync(file)))).toEqual({ width: size, height: size });
    },
  );

  it('names the built files as the release check and the release workflow expect them', () => {
    const version = '1.2.3';
    const names = builtNames(version);
    const changelog = `## [${version}]\n\n- A change.\n`;
    expect(checkRelease(`v${version}`, version, changelog, names).files).toEqual([...names].sort());
    for (const jobs of RELEASE_JOBS) {
      const patterns = patternsOfJobs(jobs);
      expect(
        names.map((name) => patterns.filter((pattern) => pattern.test(name)).length),
        jobs.join(' and '),
      ).toEqual(names.map(() => 1));
      expect(patterns.length, jobs.join(' and ')).toBe(names.length);
    }
  });

  it.each([
    'scripts/release-files.ts',
    'scripts/release-writer.ts',
    'scripts/write-release-files.ts',
  ])('%s imports nothing that needs installed packages, as the release job has none', (path) => {
    const imports = [...readFileSync(path, 'utf8').matchAll(/from '([^']+)'/g)].map(([, name]) =>
      String(name),
    );
    expect(imports.filter((name) => !/^(node:|\.\/)/.test(name))).toEqual([]);
  });

  it.each(['build/icons/tasklace.ico', 'build/icons/tasklace-file.ico'])(
    'ships %s with every size Windows asks for, each a PNG of its size',
    (path) => {
      const images = readIco(new Uint8Array(readFileSync(path)));
      expect(images.map(({ size }) => size)).toEqual(ICON_SIZES);
    },
  );

  it('gives the window a PNG icon of 256 pixels', () => {
    expect(pngSize(new Uint8Array(readFileSync('resources/icon.png')))).toEqual({
      width: WINDOW_ICON_SIZE,
      height: WINDOW_ICON_SIZE,
    });
  });

  it('names the application Tasklace and numbers it with a semantic version', () => {
    const { productName, version } = packageFile();
    expect(productName).toBe('Tasklace');
    expect(typeof version === 'string' && SEMANTIC_VERSION.test(version)).toBe(true);
  });

  it('packs the application under the same name and identifier as it runs with', () => {
    const builder = readFileSync('electron-builder.yml', 'utf8');
    expect(/^appId: (.+)$/m.exec(builder)?.[1]).toBe(APPLICATION_USER_MODEL_ID);
    expect(/^productName: (.+)$/m.exec(builder)?.[1]).toBe(packageFile().productName);
  });

  it('keeps a changelog with a part for the changes to come or for the current version', () => {
    const { version } = packageFile();
    const headings = readFileSync('CHANGELOG.md', 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('## '));
    expect(
      headings.some(
        (line) => line === '## [Unreleased]' || line.startsWith(`## [${String(version)}] - `),
      ),
    ).toBe(true);
  });
});
