@anthropic-ai/sdk 1.14.0, bundled for the browser with:
  esbuild entry.mjs --bundle --format=esm --platform=browser --minify
where entry.mjs is: export { default as Anthropic } from "@anthropic-ai/sdk";
