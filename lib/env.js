import fs from "node:fs";

// Minimal .env loader so `npm start` works without a dotenv dependency or a
// Node-version-specific --env-file flag. Existing env vars win -- except when
// they are empty, which is treated as unset so a blank placeholder cannot
// shadow a real value that was later filled in.
export function loadEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    const existing = process.env[key];
    if (key && (existing === undefined || existing === "")) process.env[key] = value;
  }
}
