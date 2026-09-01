import * as fs from 'fs';
import * as path from 'path';

export interface CanonicalPathContainment {
  canonicalPath: string;
  isWithinRoot: boolean;
}

/** Resolve one candidate against a canonical root and compare with a separator-safe boundary. */
export function resolveCanonicalPathContainment(
  canonicalRootPath: string,
  relativePath: string,
): CanonicalPathContainment {
  const canonicalPath = fs.realpathSync(path.resolve(canonicalRootPath, relativePath));
  return {
    canonicalPath,
    isWithinRoot:
      canonicalPath === canonicalRootPath ||
      canonicalPath.startsWith(canonicalRootPath + path.sep),
  };
}
