import {mkdir, readFile, writeFile, copyFile} from "node:fs/promises";
const [worker, page, script] = await Promise.all(
  ["worker/index.mjs", "web/index.html", "web/app.js"].map(path => readFile(path, "utf8"))
);
await mkdir("dist/server", {recursive: true});
await mkdir("dist/.openai", {recursive: true});
await writeFile("dist/server/index.js", "const page = " + JSON.stringify(page) + ";\nconst appScript = " + JSON.stringify(script) + ";\n" + worker);
await copyFile(".openai/hosting.json", "dist/.openai/hosting.json");
