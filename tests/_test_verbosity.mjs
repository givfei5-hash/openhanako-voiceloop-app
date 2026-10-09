import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "..", "voiceloop", "index.js"), "utf8");
const caps = src.match(/const STYLE_CAPS = \{[^}]*\};/)[0];
const fnSrc = src.match(/function closingCap\(config\) \{[\s\S]*?\n\}/)[0];
const closingCap = new Function(`${caps}\n${fnSrc}\nreturn closingCap;`)();

for (const style of ["playful", "plain", "gentle", "crisp", undefined]) {
  console.log(`style=${style ?? "(未设)"} -> 收尾上限 ${closingCap({ style })} 字`);
}
