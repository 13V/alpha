/**
 * Lets `node --test` load the app's TypeScript directly.
 *
 * The source is written for Next's bundler, which resolves `./chains` to
 * `./chains.ts` and `@/lib/x` to `src/lib/x.ts`. Node's ESM resolver does
 * neither. Rather than add a test framework and a second build, this teaches
 * the resolver those two rules — Node 22 strips the types by itself.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const HAS_EXTENSION = /\.[a-z]+$/i;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const url = pathToFileURL(resolvePath(ROOT, "src", specifier.slice(2)));
    return next(HAS_EXTENSION.test(specifier) ? url.href : `${url.href}.ts`, context);
  }
  if (specifier.startsWith(".") && !HAS_EXTENSION.test(specifier)) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
}
