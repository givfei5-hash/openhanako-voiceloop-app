import fs from "node:fs";
const src = fs.readFileSync("./index.js", "utf8");
const caps = src.match(/const STYLE_CAPS = \{[^}]*\};/)[0];
const fnSrc = src.match(/function closingCap\(config\) \{[\s\S]*?\n\}/)[0];
const closingCap = new Function(`${caps}\n${fnSrc}\nreturn closingCap;`)();

for (const style of ["playful", "plain", "gentle", "crisp", undefined]) {
  console.log(`style=${style ?? "(未设)"} -> 收尾上限 ${closingCap({ style })} 字`);
}
