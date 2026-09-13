import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { checkCoreDependencies } from "./check-core-dependencies.mjs";

const devRoot = process.env.PCHAT_DEV_ROOT;
if (!devRoot || !isAbsolute(devRoot)) {
  throw new Error("PCHAT_DEV_ROOT must identify an absolute development-output directory.");
}
const fixtureParent = resolve(devRoot, "temp", "pchat", "dependency-check");
const fixtures: string[] = [];

async function fixture() {
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(join(fixtureParent, "fixture-"));
  fixtures.push(root);
  for (const name of ["contracts", "harness", "client"]) {
    const directory = join(root, "packages", name);
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: `@pchat/${name}`,
      dependencies: name === "contracts" ? { zod: "1.0.0" } : { "@pchat/contracts": "workspace:*" },
    }));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: { lib: ["ES2023"], types: [] },
      include: ["src"],
    }));
    await writeFile(join(directory, "src", "index.ts"), "export const ready = true;\n");
  }
  return root;
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    const within = relative(fixtureParent, resolve(root));
    if (!within || within.startsWith("..") || isAbsolute(within)) {
      throw new Error("Refusing to remove a path outside the dependency-check fixture directory.");
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("core dependency boundary", () => {
  it("accepts pure core packages without treating quoted examples as dependencies", async () => {
    const root = await fixture();
    await writeFile(join(root, "packages", "harness", "src", "index.ts"), `
      import type { HarnessCommand } from "@pchat/contracts";
      // import { readFile } from "node:fs";
      export const example = 'require("react")';
      export type Command = HarnessCommand;
    `);
    await writeFile(join(root, "packages", "client", "src", "index.ts"), 'export type { HarnessCommand } from "@pchat/contracts";');
    expect(await checkCoreDependencies(root)).toEqual([]);
  });

  it.each([
    ['import { readFile } from "node:fs";', "node:fs"],
    ['export { useState } from "react";', "react"],
    ['const host = import("@tauri-apps/api");', "@tauri-apps/api"],
    ['const store = require("@pchat/adapters-store");', "require"],
    ['type Database = import("node:sqlite").DatabaseSync;', "node:sqlite"],
    ['import fs = require("fs");', "fs"],
    ['const name = "node:fs"; const loader = import(name);', "dynamic"],
  ])("rejects dependency syntax in production code: %s", async (source, rejected) => {
    const root = await fixture();
    await writeFile(join(root, "packages", "harness", "src", "index.ts"), source);
    const errors = await checkCoreDependencies(root);
    expect(errors.some((error) => error.code === "SOURCE_DEPENDENCY" && error.message.includes(rejected))).toBe(true);
  });

  it.each(["@pchat/harness", "react", "node:fs", "@tauri-apps/api"])("rejects a client import outside its contracts boundary: %s", async (dependency) => {
    const root = await fixture();
    const file = join(root, "packages", "client", "src", "index.ts");
    await writeFile(file, `import "${dependency}";`);
    expect(await checkCoreDependencies(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file, code: "SOURCE_DEPENDENCY", message: expect.stringContaining(dependency) }),
    ]));
  });

  it("reports an absent required core package instead of silently passing", async () => {
    const root = await fixture();
    await rm(join(root, "packages", "harness", "package.json"));
    expect(await checkCoreDependencies(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PACKAGE_MANIFEST" }),
    ]));
  });

  it.each(["dependencies", "peerDependencies", "optionalDependencies"])(
    "rejects a concrete adapter declared through %s", async (field) => {
      const root = await fixture();
      await writeFile(join(root, "packages", "harness", "package.json"), JSON.stringify({
        name: "@pchat/harness", [field]: { "@pchat/adapters-model": "workspace:*" },
      }));
      expect(await checkCoreDependencies(root)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "PACKAGE_DEPENDENCY" }),
      ]));
    },
  );

  it.each(["dependencies", "peerDependencies", "optionalDependencies"])("rejects client access to the harness implementation through %s", async (field) => {
    const root = await fixture();
    const file = join(root, "packages", "client", "package.json");
    await writeFile(file, JSON.stringify({ name: "@pchat/client", [field]: { "@pchat/harness": "workspace:*" } }));
    expect(await checkCoreDependencies(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file, code: "PACKAGE_DEPENDENCY" }),
    ]));
  });

  it.each([
    { lib: ["ES2023", "DOM"], types: [] },
    { lib: ["ES2023"], types: ["node"] },
    { lib: ["ES2023"] },
  ])("rejects ambient platform capabilities in compiler options %j", async (compilerOptions) => {
    const root = await fixture();
    await writeFile(join(root, "packages", "harness", "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["src"] }));
    expect(await checkCoreDependencies(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COMPILER_BOUNDARY" }),
    ]));
  });

  it.each([
    { lib: ["ES2023", "DOM"], types: [] },
    { lib: ["ES2023"], types: ["node"] },
    { lib: ["ES2023"] },
  ])("rejects client platform capabilities in compiler options %j", async (compilerOptions) => {
    const root = await fixture();
    const file = join(root, "packages", "client", "tsconfig.json");
    await writeFile(file, JSON.stringify({ compilerOptions, include: ["src"] }));
    expect(await checkCoreDependencies(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file, code: "COMPILER_BOUNDARY" }),
    ]));
  });

  it.each([
    'import { runtime } from "../../../runtime-windows/index.js";',
    'export { fake } from "./adapter.test.js";',
    '/// <reference types="node" />\nexport {};',
    '/// <reference lib="dom" />\nexport {};',
    '/// <reference path="../../../runtime-windows/index.d.ts" />\nexport {};',
  ])("rejects paths and directives that bypass the package boundary: %s", async (source) => {
    const root = await fixture();
    await writeFile(join(root, "packages", "harness", "src", "index.ts"), source);
    expect(await checkCoreDependencies(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SOURCE_DEPENDENCY" }),
    ]));
  });

  it("allows local modules and excludes tests from the production source boundary", async () => {
    const root = await fixture();
    const src = join(root, "packages", "harness", "src");
    await writeFile(join(src, "index.ts"), 'export { value } from "./value.js";');
    await writeFile(join(src, "value.ts"), 'export const value = "node:sqlite";');
    await writeFile(join(src, "adapter.test.ts"), 'import { FakeModel } from "@pchat/testing";');
    expect(await checkCoreDependencies(root)).toEqual([]);
  });

  it("rejects compiler path aliases that could replace an allowed package", async () => {
    const root = await fixture();
    await writeFile(join(root, "packages", "harness", "tsconfig.json"), JSON.stringify({
      compilerOptions: { lib: ["ES2023"], types: [], paths: { "@pchat/contracts": ["../../../apps/runtime-windows/index.ts"] } },
      include: ["src"],
    }));
    expect(await checkCoreDependencies(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COMPILER_BOUNDARY" }),
    ]));
  });

  it("makes the command-line gate succeed for portable code and fail for a platform import", async () => {
    const root = await fixture();
    const script = fileURLToPath(new URL("./check-core-dependencies.mjs", import.meta.url));
    const run = () => promisify(execFile)(process.execPath, [script, root], { windowsHide: true });
    const accepted = await run();
    expect(accepted.stdout).toContain("Core dependency check passed");
    await writeFile(join(root, "packages", "harness", "src", "index.ts"), 'import "node:fs";');
    await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("node:fs") });
  });
});
