import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../lib/env.js";

function tempEnvFile(contents) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "jgg-env-")),
    ".env",
  );
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

const KEY = "JGG_TEST_ONLY_VALUE";

test.afterEach(() => {
  delete process.env[KEY];
});

test("a value is read from the file when the variable is unset", () => {
  delete process.env[KEY];
  loadEnv(tempEnvFile(`${KEY}=from-file\n`));
  assert.equal(process.env[KEY], "from-file");
});

test("a real existing value is not overwritten", () => {
  process.env[KEY] = "from-environment";
  loadEnv(tempEnvFile(`${KEY}=from-file\n`));
  assert.equal(process.env[KEY], "from-environment");
});

// The reason for this: .env ships with `JEV_API_KEY=` blank. Once that blank
// line has been loaded the variable is defined-but-empty, and without this
// rule a key pasted in afterwards could never be picked up.
test("an empty existing value is treated as unset and gets replaced", () => {
  process.env[KEY] = "";
  loadEnv(tempEnvFile(`${KEY}=from-file\n`));
  assert.equal(process.env[KEY], "from-file");
});

test("comments, blank lines and quotes are handled", () => {
  delete process.env[KEY];
  loadEnv(
    tempEnvFile(
      ["# a comment", "", `${KEY}="quoted value"`, "MALFORMED_NO_EQUALS"].join("\n"),
    ),
  );
  assert.equal(process.env[KEY], "quoted value");
});

test("a missing file is not an error", () => {
  assert.doesNotThrow(() => loadEnv(path.join(os.tmpdir(), "jgg-does-not-exist", ".env")));
});
