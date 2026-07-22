import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono, type Context } from "hono";

interface AdminEnvironment {
  Variables: { requestId: string };
}

const ADMIN_DIST = fileURLToPath(new URL("../../../admin/dist/admin/", import.meta.url));
const ASSET_NAME = /^[A-Za-z0-9._-]+\.(?:css|js|png|svg|woff2)$/u;
const MANIFEST_ASSET = /^assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{12}\.(?:css|js|png|svg|woff2)$/u;

interface ViteEntry {
  file: string;
  css?: string[];
  assets?: string[];
  isEntry?: boolean;
}

function attributes(source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of source.matchAll(
    /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu,
  )) {
    result.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function shellMatchesManifest(html: string, entry: ViteEntry): boolean {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
  if (scripts.length !== 1 || (html.match(/<script\b/giu) ?? []).length !== 1) return false;
  const script = attributes(scripts[0]![1]!);
  if (scripts[0]![2]!.trim() || script.get("type") !== "module" ||
      script.get("src") !== `/admin/${entry.file}`) return false;
  const styles = [...html.matchAll(/<link\b([^>]*)>/giu)]
    .map((match) => attributes(match[1]!))
    .filter((record) => (record.get("rel") ?? "").split(/\s+/u).includes("stylesheet"))
    .map((record) => record.get("href"));
  const expected = (entry.css ?? []).map((asset) => `/admin/${asset}`).toSorted();
  return styles.length === expected.length &&
    styles.every((value): value is string => typeof value === "string") &&
    styles.toSorted().every((value, index) => value === expected[index]);
}

async function readRegularFile(relative: string): Promise<Buffer> {
  const absolute = join(ADMIN_DIST, relative);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe administrator asset");
  const parent = await realpath(dirname(absolute));
  const root = await realpath(ADMIN_DIST);
  if (parent !== root && parent !== join(root, "assets")) throw new Error("administrator asset escaped dist");
  return readFile(absolute);
}

async function loadBuild(): Promise<{ html: string; assets: Set<string> }> {
  const [htmlBuffer, manifestBuffer] = await Promise.all([
    readRegularFile("index.html"),
    readRegularFile("manifest.json"),
  ]);
  const parsed: unknown = JSON.parse(manifestBuffer.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid administrator manifest");
  }
  const entry = (parsed as Record<string, unknown>)["index.html"] as ViteEntry | undefined;
  if (!entry || entry.isEntry !== true || !MANIFEST_ASSET.test(entry.file)) {
    throw new Error("administrator entry is missing");
  }
  const assets = new Set<string>();
  for (const value of Object.values(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid administrator manifest entry");
    }
    const record = value as ViteEntry;
    if (typeof record.file !== "string") throw new Error("invalid administrator manifest file");
    for (const asset of [record.file, ...(record.css ?? []), ...(record.assets ?? [])]) assets.add(asset);
  }
  if ([...assets].some((asset) => !MANIFEST_ASSET.test(asset))) {
    throw new Error("invalid administrator manifest asset");
  }
  const html = htmlBuffer.toString("utf8");
  if (!shellMatchesManifest(html, entry) || !html.includes('id="root"')) {
    throw new Error("administrator shell entry is invalid");
  }
  return { html, assets };
}

export function registerAdminSpaRoutes(app: Hono<AdminEnvironment>): void {
  app.get("/admin/assets/*", async (context) => {
    const name = context.req.path.slice("/admin/assets/".length);
    if (!ASSET_NAME.test(name) || name.includes("..")) return context.notFound();
    const contentType = name.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : name.endsWith(".css")
        ? "text/css; charset=utf-8"
        : name.endsWith(".svg")
          ? "image/svg+xml"
          : name.endsWith(".png")
            ? "image/png"
            : name.endsWith(".woff2")
              ? "font/woff2"
              : undefined;
    if (!contentType) return context.notFound();
    try {
      const build = await loadBuild();
      if (!build.assets.has(`assets/${name}`)) return context.notFound();
      const body = await readRegularFile(`assets/${name}`);
      return context.body(new Uint8Array(body), 200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      });
    } catch {
      return context.notFound();
    }
  });

  const shell = async (context: Context<AdminEnvironment>) => {
    try {
      return context.html((await loadBuild()).html, 200, {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      });
    } catch {
      return context.text("Administrator application is unavailable", 503, {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      });
    }
  };
  app.get("/admin", shell);
  app.get("/admin/*", shell);
}
