import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// TypeScript 7 exposes its AST through versioned, unstable compiler APIs.
// Keep the workspace compiler version pinned and run this suite when upgrading it.
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";

const packages = [
  { name: "contracts", allowed: ["zod"] },
  { name: "harness", allowed: ["@pchat/contracts"] },
];

/** @typedef {{file: string, code: string, message: string}} Violation */

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

/** @param {string} workspaceRoot
 * @returns {Promise<Violation[]>}
 */
export async function checkCoreDependencies(workspaceRoot) {
  const errors = [];
  const api = new API({ cwd: workspaceRoot });
  try {
    for (const rule of packages) {
      const directory = join(workspaceRoot, "packages", rule.name);
      const manifestPath = join(directory, "package.json");
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (manifest.name !== `@pchat/${rule.name}`) throw new Error("The core package name is incorrect.");
      } catch (error) {
        errors.push({ file: manifestPath, code: "PACKAGE_MANIFEST", message: `Required core package cannot be read: ${error.message}` });
        continue;
      }
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          if (!rule.allowed.includes(dependency)) {
            errors.push({ file: manifestPath, code: "PACKAGE_DEPENDENCY", message: `${field} includes forbidden dependency ${dependency}.` });
          }
        }
      }
      const configPath = join(directory, "tsconfig.json");
      try {
        await readFile(configPath, "utf8");
        const { options } = api.parseConfigFile(configPath);
        if (!Array.isArray(options.lib) || options.lib.length !== 1 || options.lib[0] !== "lib.es2023.d.ts" ||
            !Array.isArray(options.types) || options.types.length !== 0) {
          errors.push({ file: configPath, code: "COMPILER_BOUNDARY", message: "Core compiler options must use lib: [ES2023] and types: [] (including inherited options)." });
        }
        if (Object.keys(options.paths ?? {}).length || (options.rootDirs ?? []).length) {
          errors.push({ file: configPath, code: "COMPILER_BOUNDARY", message: "Core path aliases and rootDirs must not bypass package source boundaries." });
        }
      } catch (error) {
        errors.push({ file: configPath, code: "COMPILER_BOUNDARY", message: `Core compiler config cannot be read: ${error.message}` });
        continue;
      }
      const src = join(directory, "src");
      let files;
      try {
        files = await sourceFiles(src);
      } catch (error) {
        errors.push({ file: src, code: "SOURCE_BOUNDARY", message: `Core sources cannot be read: ${error.message}` });
        continue;
      }
      const snapshot = api.updateSnapshot({ openFiles: files });
      for (const file of files) {
        const source = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
        if (!source) throw new Error(`TypeScript could not parse ${file}.`);
        const reject = (message) => errors.push({ file, code: "SOURCE_DEPENDENCY", message });
        const checkRelativePath = (specifier) => {
          const within = relative(src, resolve(dirname(file), specifier));
          if (!within || within.startsWith("..") || isAbsolute(within) || /\.test(?:\.[cm]?[jt]sx?)?$/.test(within)) {
            reject(`Relative dependency ${specifier} leaves production ${rule.name}/src.`);
          }
        };
        const checkSpecifier = (specifier) => {
          if (!specifier || !(ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
            reject("Non-literal dynamic dependencies cannot be checked.");
          } else if (specifier.text.startsWith(".")) {
            checkRelativePath(specifier.text);
          } else if (!rule.allowed.includes(specifier.text)) {
            reject(`Dependency ${specifier.text} is outside the ${rule.name} boundary.`);
          }
        };
        for (const reference of source.typeReferenceDirectives) reject(`Ambient type dependency ${reference.fileName} bypasses types: [].`);
        for (const reference of source.libReferenceDirectives) {
          if (reference.fileName.toLowerCase() !== "es2023") reject(`Ambient library dependency ${reference.fileName} is not ECMAScript.`);
        }
        for (const reference of source.referencedFiles) checkRelativePath(reference.fileName);
        const visit = (node) => {
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            if (node.moduleSpecifier) checkSpecifier(node.moduleSpecifier);
          } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            checkSpecifier(node.moduleReference.expression);
          } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
            checkSpecifier(node.argument.literal);
          } else if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) checkSpecifier(node.arguments[0]);
            else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
              reject("CommonJS require is a Node dependency; use ECMAScript imports.");
            }
          }
          node.forEachChild(visit);
        };
        visit(source);
      }
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
  return errors;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const workspaceRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
  try {
    const violations = await checkCoreDependencies(workspaceRoot);
    if (violations.length) {
      for (const violation of violations) {
        console.error(`${relative(workspaceRoot, violation.file)} [${violation.code}] ${violation.message}`);
      }
      process.exitCode = 1;
    } else {
      console.log("Core dependency check passed: contracts and harness use portable boundaries.");
    }
  } catch (error) {
    console.error(`Core dependency check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
