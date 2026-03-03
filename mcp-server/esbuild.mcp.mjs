/**
 * esbuild config for the MCP server.
 *
 * Bundles all source + @modelcontextprotocol/sdk into a single out/index.js.
 * @duckdb/node-api is external (NAPI native module, shared with the extension).
 *
 * The MCP server uses ESM ("type": "module" in package.json), so format is esm.
 * A createRequire banner is added for any CJS-only dependencies.
 *
 * Usage:
 *   node esbuild.mcp.mjs
 */
import * as esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ajv's standalone compiled validators embed require() calls for runtime helpers.
// These are inside string literals in pre-compiled code, so esbuild can't resolve them.
// We inject the actual runtime modules and replace the requires with references.
import fs from "fs";

function readAjvModule(mod) {
  const p = path.resolve(__dirname, "node_modules", mod + ".js");
  return fs.readFileSync(p, "utf-8");
}

const ajvInjectPlugin = {
  name: "ajv-inject",
  setup(build) {
    // After bundling, replace the require() calls with inline module references
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      const outfile = path.resolve(__dirname, "out/index.js");
      let code = fs.readFileSync(outfile, "utf-8");

      // Map of require("...") → inline replacement
      const replacements = {
        'require("ajv/dist/runtime/equal")': '(function(){function equal(a,b){if(a===b)return true;if(a&&b&&typeof a=="object"&&typeof b=="object"){if(a.constructor!==b.constructor)return false;var length,i,keys;if(Array.isArray(a)){length=a.length;if(length!=b.length)return false;for(i=length;i--!==0;)if(!equal(a[i],b[i]))return false;return true}if(a instanceof Map&&b instanceof Map){if(a.size!==b.size)return false;for(i of a.entries())if(!b.has(i[0]))return false;for(i of a.entries())if(!equal(i[1],b.get(i[0])))return false;return true}if(a instanceof Set&&b instanceof Set){if(a.size!==b.size)return false;for(i of a.entries())if(!b.has(i[0]))return false;return true}if(a.constructor===RegExp)return a.source===b.source&&a.flags===b.flags;if(a.valueOf!==Object.prototype.valueOf)return a.valueOf()===b.valueOf();if(a.toString!==Object.prototype.toString)return a.toString()===b.toString();keys=Object.keys(a);length=keys.length;if(length!==Object.keys(b).length)return false;for(i=length;i--!==0;)if(!Object.prototype.hasOwnProperty.call(b,keys[i]))return false;for(i=length;i--!==0;){var key=keys[i];if(!equal(a[key],b[key]))return false}return true}return a!==a&&b!==b};return{default:equal}}).call(this)',
        'require("ajv/dist/runtime/validation_error")': `(function(){class ValidationError extends Error{constructor(e){super("validation failed");this.errors=e;this.ajv=this.validation=true}};return{default:ValidationError}}).call(this)`,
        'require("ajv/dist/runtime/uri")': '(function(){return{default:{parse:function(s){try{return new URL(s),{reference:"uri"}}catch{return null}},serialize:function(c){return c?.reference??""}}}}).call(this)',
        'require("ajv/dist/runtime/ucs2length")': '(function(){return{default:function(s){var l=0,i=0,c;for(;i<s.length;l++){c=s.charCodeAt(i++);if(c>=55296&&c<=56319&&i<s.length)i++}return l}}}).call(this)',
        'require("ajv-formats/dist/formats")': '(function(){return{default:{}}}).call(this)',
      };

      let replaced = 0;
      for (const [from, to] of Object.entries(replacements)) {
        if (code.includes(from)) {
          code = code.replace(from, to);
          replaced++;
        }
      }

      if (replaced > 0) {
        fs.writeFileSync(outfile, code);
        console.log(`  Inlined ${replaced} ajv runtime require() calls.`);
      }
    });
  },
};

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "out/index.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  external: [
    "@duckdb/node-api",
    "@duckdb/node-bindings",
  ],
  plugins: [ajvInjectPlugin],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  minify: true,
  sourcemap: false,
  logLevel: "info",
});

console.log("MCP server built.");
