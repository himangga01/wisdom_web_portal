import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const prototypeRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(prototypeRoot, "../..");
const outputDir = resolve(workspaceRoot, ".superpowers/brainstorm/renders");
const outputPath = resolve(outputDir, "wisdom-homepage-dynamic-c1-demo.html");

let html = await readFile(resolve(prototypeRoot, "dist/index.html"), "utf8");
const scriptMatch = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/);
const styleMatch = html.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/);

if (!scriptMatch || !styleMatch) {
  throw new Error("Built JavaScript or CSS entry was not found");
}

const assetPath = (webPath) => resolve(prototypeRoot, "dist", webPath.replace(/^\//, ""));
const javascript = await readFile(assetPath(scriptMatch[1]), "utf8");
let css = await readFile(assetPath(styleMatch[1]), "utf8");
const portrait = await readFile(resolve(prototypeRoot, "public/images/representative-brochure.jpg"));
const portraitDataUrl = `data:image/jpeg;base64,${portrait.toString("base64")}`;

css = css.replace(
  /url\((?:["']?)\/images\/representative-brochure\.jpg(?:["']?)\)/g,
  `url("${portraitDataUrl}")`,
);

html = html
  .replace(
    scriptMatch[0],
    `<script type="module">\n${javascript.replaceAll("</script>", "<\\/script>")}\n</script>`,
  )
  .replace(
    styleMatch[0],
    `<style>\n${css.replaceAll("</style>", "<\\/style>")}\n</style>`,
  )
  .replace("<head>", "<head>\n    <!-- CSS, JavaScript, 대표 사진을 포함한 독립 실행형 샘플 -->");

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, html, "utf8");
console.log(outputPath);
