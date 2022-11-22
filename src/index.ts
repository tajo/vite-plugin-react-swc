import {
  existsSync,
  mkdirSync,
  promises,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { SourceMapPayload } from "module";
import {
  Output,
  ParserConfig,
  transform,
  version as swcVersion,
} from "@swc/core";
import { PluginOption } from "vite";

const runtimePublicPath = "/@react-refresh";

const preambleCode = `import { injectIntoGlobalHook } from "${runtimePublicPath}";
injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;`;

const _dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

let root: string;
let cachePath: string;
const PLUGIN_CACHE_VERSION = 1;
type CacheEntry = {
  input: string;
  code: string;
  map: SourceMapPayload;
};
type MetadataCache = { version: string };
const cache = new Map<string, CacheEntry>();

const react = (): PluginOption[] => [
  {
    name: "@vitejs/plugin-react-swc",
    apply: "serve",
    config: () => ({
      esbuild: false,
      optimizeDeps: { include: ["react/jsx-dev-runtime"] },
    }),
    resolveId: (id) => (id === runtimePublicPath ? id : undefined),
    load: (id) =>
      id === runtimePublicPath
        ? readFileSync(join(_dirname, "refresh-runtime.js"), "utf-8")
        : undefined,
    transformIndexHtml: () => [
      { tag: "script", attrs: { type: "module" }, children: preambleCode },
    ],
    configResolved: async (config) => {
      if (cache.size > 0) return;
      root = config.root;
      cachePath = join(config.cacheDir, "swc-cache");
      const metadataPath = join(cachePath, "_metadata.json");
      const version = `${PLUGIN_CACHE_VERSION}-${swcVersion}`;
      if (existsSync(metadataPath)) {
        const content = readFileSync(metadataPath, "utf-8");
        const previousCache = JSON.parse(content) as MetadataCache;
        if (previousCache.version === version) {
          const start = performance.now();
          await Promise.all(
            readdirSync(cachePath)
              .filter((f) => f.endsWith(".json") && f !== "_metadata.json")
              .map(async (f) => {
                const json = await promises.readFile(
                  `${cachePath}/${f}`,
                  "utf-8",
                );
                cache.set(f, JSON.parse(json));
              }),
          );
          console.log(
            `cache restored: ${(performance.now() - start).toFixed(2)}ms`,
          );
        } else {
          rmSync(cachePath, { recursive: true, force: true });
          mkdirSync(cachePath);
        }
      } else {
        mkdirSync(cachePath, { recursive: true });
      }
      const metadataCache: MetadataCache = { version };
      writeFileSync(metadataPath, JSON.stringify(metadataCache));
    },
    async transform(code, id, transformOptions) {
      if (id.includes("node_modules")) return;

      const parser: ParserConfig | undefined = id.endsWith(".tsx")
        ? { syntax: "typescript", tsx: true }
        : id.endsWith(".ts")
        ? { syntax: "typescript", tsx: false }
        : id.endsWith(".jsx")
        ? { syntax: "ecmascript", jsx: true }
        : undefined;
      if (!parser) return;

      const ssr = transformOptions?.ssr;
      const fileCachePath = `${relative(root, id).replace(/\//g, "|")}${
        ssr ? "-srr" : ""
      }.json`;
      const cachedEntry = cache.get(fileCachePath);
      if (cachedEntry?.input === code) {
        return { code: cachedEntry.code, map: cachedEntry.map };
      }

      let result: Output;
      try {
        result = await transform(code, {
          filename: id,
          swcrc: false,
          configFile: false,
          sourceMaps: true,
          jsc: {
            target: "es2020",
            parser,
            transform: {
              useDefineForClassFields: true,
              react: {
                refresh: !ssr,
                development: true,
                useBuiltins: true,
                runtime: "automatic",
              },
            },
          },
        });
      } catch (e: any) {
        const message: string = e.message;
        const fileStartIndex = message.indexOf("╭─[");
        if (fileStartIndex !== -1) {
          const match = message.slice(fileStartIndex).match(/:(\d+):(\d+)]/);
          if (match) {
            e.line = match[1];
            e.column = match[2];
          }
        }
        throw e;
      }

      const sourceMap: SourceMapPayload = JSON.parse(result.map!);

      if (result.code.includes("$RefreshReg$")) {
        sourceMap.mappings = ";;;;;;;;" + sourceMap.mappings;
        result.code = `import * as RefreshRuntime from "${runtimePublicPath}";
  
  if (!window.$RefreshReg$) throw new Error("React refresh preamble was not loaded. Something is wrong.");
  const prevRefreshReg = window.$RefreshReg$;
  const prevRefreshSig = window.$RefreshSig$;
  window.$RefreshReg$ = RefreshRuntime.getRefreshReg("${id}");
  window.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;
  
  ${result.code}
  
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;
  import.meta.hot.accept((nextExports) => {
  if (!nextExports) return;
  import(/* @vite-ignore */ import.meta.url).then((current) => {
    const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate(current, nextExports);
    if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
  });
});
  `;
      }

      const entry: CacheEntry = {
        input: code,
        code: result.code,
        map: sourceMap,
      };
      promises.writeFile(
        `${cachePath}/${fileCachePath}`,
        JSON.stringify(entry),
      );

      return { code: result.code, map: sourceMap };
    },
  },
  {
    name: "@vitejs/plugin-react-swc",
    apply: "build",
    config: () => ({
      esbuild: {
        jsx: "automatic",
        tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
      },
    }),
  },
];

export default react;
