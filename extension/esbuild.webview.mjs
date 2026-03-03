import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";

const isWatch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  loader: {
    ".tsx": "tsx",
    ".ts": "ts",
    ".css": "css",
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  minify: !isWatch,
  sourcemap: isWatch,
};

const canvasConfig = {
  ...shared,
  entryPoints: ["src/canvas/app/index.tsx"],
  outfile: "webview/canvas.js",
};

const connectorConfig = {
  ...shared,
  entryPoints: ["src/connector/app/index.tsx"],
  outfile: "webview/connector.js",
};

// ── Vendor copy: CesiumJS + Three.js ──
// Copies runtime subsets to webview/vendor/ for serving via /vendor/* routes.
// These are NOT bundled into the webview JS — they're loaded dynamically by
// frame HTML via __JET.loadCesium() / __JET.loadThree().

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function copyVendor() {
  const vendorDir = "webview/vendor";
  fs.mkdirSync(vendorDir, { recursive: true });

  // ── CesiumJS (runtime subset, skip IAU2006_XYS ephemeris ~1.8MB) ──
  const cesiumSrc = "node_modules/cesium/Build/Cesium";
  const cesiumDest = path.join(vendorDir, "cesium");
  if (fs.existsSync(cesiumSrc)) {
    fs.mkdirSync(cesiumDest, { recursive: true });
    // Main library
    fs.copyFileSync(path.join(cesiumSrc, "Cesium.js"), path.join(cesiumDest, "Cesium.js"));
    // Workers (tile decoding, geometry processing)
    copyDirSync(path.join(cesiumSrc, "Workers"), path.join(cesiumDest, "Workers"));
    // Widget CSS
    copyDirSync(path.join(cesiumSrc, "Widgets"), path.join(cesiumDest, "Widgets"));
    // ThirdParty (draco, basis transcoder, etc.)
    copyDirSync(path.join(cesiumSrc, "ThirdParty"), path.join(cesiumDest, "ThirdParty"));
    // Assets — only Images (icons) and Textures (skybox, earth)
    const assetsDest = path.join(cesiumDest, "Assets");
    fs.mkdirSync(assetsDest, { recursive: true });
    if (fs.existsSync(path.join(cesiumSrc, "Assets/Images"))) {
      copyDirSync(path.join(cesiumSrc, "Assets/Images"), path.join(assetsDest, "Images"));
    }
    if (fs.existsSync(path.join(cesiumSrc, "Assets/Textures"))) {
      copyDirSync(path.join(cesiumSrc, "Assets/Textures"), path.join(assetsDest, "Textures"));
    }
    console.log("  Cesium vendor copied.");
  } else {
    console.warn("  WARNING: cesium not found in node_modules — skipping vendor copy");
  }

  // ── Three.js (module + key addons) ──
  const threeSrc = "node_modules/three";
  const threeDest = path.join(vendorDir, "three");
  if (fs.existsSync(threeSrc)) {
    fs.mkdirSync(threeDest, { recursive: true });
    // Main module
    fs.copyFileSync(path.join(threeSrc, "build/three.module.min.js"), path.join(threeDest, "three.module.min.js"));
    // Addons
    const addonsDir = path.join(threeDest, "addons");
    fs.mkdirSync(addonsDir, { recursive: true });
    const addons = [
      "controls/OrbitControls.js",
      "loaders/GLTFLoader.js",
      "loaders/DRACOLoader.js",
      "objects/Sky.js",
      "objects/Water.js",
    ];
    for (const addon of addons) {
      const src = path.join(threeSrc, "examples/jsm", addon);
      const destFile = path.join(addonsDir, path.basename(addon));
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, destFile);
      }
    }
    // DRACO decoder (WASM + JS fallback)
    const dracoSrc = path.join(threeSrc, "examples/jsm/libs/draco");
    const dracoDest = path.join(threeDest, "draco");
    if (fs.existsSync(dracoSrc)) {
      copyDirSync(dracoSrc, dracoDest);
    }
    console.log("  Three.js vendor copied.");
  } else {
    console.warn("  WARNING: three not found in node_modules — skipping vendor copy");
  }
}

if (isWatch) {
  const ctx1 = await esbuild.context(canvasConfig);
  const ctx2 = await esbuild.context(connectorConfig);
  await ctx1.watch();
  await ctx2.watch();
  console.log("Watching webviews...");
} else {
  await esbuild.build(canvasConfig);
  await esbuild.build(connectorConfig);
  console.log("Copying vendor libraries...");
  copyVendor();
  console.log("Webview built.");
}
