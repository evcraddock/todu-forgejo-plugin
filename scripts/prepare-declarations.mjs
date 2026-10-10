#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

// tsc retains source aliases in declarations. Ship package-relative Node ESM
// references so consumers need neither this checkout nor its tsconfig aliases.
for (const name of fs.readdirSync("dist").filter((name) => name.endsWith(".d.ts"))) {
  const file = path.join("dist", name);
  const text = fs
    .readFileSync(file, "utf8")
    .replace(/(["'])@\/([^"']+)\1/g, (_match, quote, module) => {
      if (!fs.existsSync(path.join("dist", `${module}.d.ts`))) {
        throw new Error(`Missing declaration target: ${module} in ${name}`);
      }
      return `${quote}./${module}.js${quote}`;
    });
  fs.writeFileSync(file, text);
}
