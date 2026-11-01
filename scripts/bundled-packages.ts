import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface BundledChunk {
  readonly type: string;
  readonly moduleIds?: readonly string[];
}

interface BundlePlugin {
  readonly name: string;
  readonly generateBundle: (options: unknown, bundle: Record<string, BundledChunk>) => void;
  readonly closeBundle: () => Promise<void>;
}

const PACKAGE_FOLDER = 'node_modules/';
const SCOPE_MARK = '@';

/** Gives the name of the package a module of a bundle comes from, scoped names included, or null for a module of the application itself. */
export function packageNameOf(moduleId: string): string | null {
  const path = moduleId.replaceAll('\\', '/').replace(/^\0/, '').replace(/\?.*$/, '');
  const start = path.lastIndexOf(PACKAGE_FOLDER);
  if (start === -1) {
    return null;
  }
  const parts = path.slice(start + PACKAGE_FOLDER.length).split('/');
  const [first = '', second = ''] = parts;
  if (first.startsWith(SCOPE_MARK)) {
    return second === '' ? null : `${first}/${second}`;
  }
  return first === '' ? null : first;
}

/** Lists once, in order, the packages whose code the chunks of a bundle hold. */
export function packagesOfBundle(bundle: Readonly<Record<string, BundledChunk>>): string[] {
  const names = Object.values(bundle)
    .flatMap((chunk) => (chunk.type === 'chunk' ? (chunk.moduleIds ?? []) : []))
    .flatMap((moduleId) => {
      const name = packageNameOf(moduleId);
      return name === null ? [] : [name];
    });
  return [...new Set(names)].sort((first, second) => first.localeCompare(second, 'en'));
}

/** Builds a bundler plugin that writes, once a bundle is written, the list of packages whose code it holds, so that their licenses ship with the application even when they are only installed to build it. */
export function bundledPackagesPlugin(listFile: string): BundlePlugin {
  let names: string[] = [];
  return {
    name: 'tasklace-bundled-packages',
    generateBundle: (_options, bundle) => {
      names = packagesOfBundle(bundle);
    },
    closeBundle: async () => {
      await mkdir(dirname(listFile), { recursive: true });
      await writeFile(listFile, `${JSON.stringify(names, null, 2)}\n`);
    },
  };
}
