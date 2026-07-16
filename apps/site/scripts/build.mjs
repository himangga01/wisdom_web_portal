import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const rawArguments = process.argv.slice(2);
const fixtureRequested = rawArguments[0] === "--fixture";
const argumentsForAstro = fixtureRequested ? rawArguments.slice(1) : rawArguments;
if (rawArguments.includes("--fixture") && !fixtureRequested) {
  console.error("SITE_BUILD_FIXTURE_FLAG_INVALID");
  process.exit(1);
}

const fixtureDirectory = fileURLToPath(
  new URL("../src/content/__fixtures__/published-content", import.meta.url),
);
const publishedContentDirectory = fixtureRequested
  ? fixtureDirectory
  : process.env.WISDOM_PUBLISHED_CONTENT_DIR;

if (!publishedContentDirectory) {
  console.error("SITE_BUILD_PUBLISHED_CONTENT_REQUIRED");
  process.exit(1);
}
if (!isAbsolute(publishedContentDirectory)) {
  console.error("SITE_BUILD_PUBLISHED_CONTENT_NOT_ABSOLUTE");
  process.exit(1);
}

const astroCli = fileURLToPath(new URL("../bin/astro.mjs", import.meta.resolve("astro")));
const result = spawnSync(process.execPath, [astroCli, "build", ...argumentsForAstro], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    NODE_ENV: "production",
    ...(fixtureRequested && !process.env.PUBLIC_ORIGIN
      ? { PUBLIC_ORIGIN: "https://www.jihye-office.kr" }
      : {}),
    WISDOM_PUBLISHED_CONTENT_DIR: publishedContentDirectory,
  },
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error("SITE_BUILD_PROCESS_FAILED");
  process.exit(1);
}
process.exit(result.status ?? 1);
