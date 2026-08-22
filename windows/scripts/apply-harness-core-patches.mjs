import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_MARKER = 'deepseek-harness-local-vision-host-v1';
const ADAPTER_MARKER = 'deepseek-harness-local-vision-adapter-v1';
const TYPES_MARKER = 'deepseek-harness-local-vision-types-v1';
const BRAND_SIDEBAR_MARKER = 'deep-seek-yu-sidebar-brand-v1';
const BRAND_RUNTIME_MARKER = 'deep-seek-yu-runtime-brand-v1';

function replaceOnce(source, before, after, target) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Harness core patch target changed: ${target}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Harness core patch target is ambiguous: ${target}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function patchFile(relative, marker, transform) {
  const filename = path.join(root, relative);
  const source = readFileSync(filename, 'utf8');
  if (source.includes(marker)) return;
  const patched = transform(source);
  writeFileSync(filename, `${patched}\n/* ${marker} */\n`, 'utf8');
}

function replaceTextFile(relative, before, after, target) {
  const filename = path.join(root, relative);
  const source = readFileSync(filename, 'utf8');
  if (source.includes(after)) return;
  const patched = replaceOnce(source, before, after, target);
  writeFileSync(filename, patched, 'utf8');
}

patchFile(
  'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js',
  HOST_MARKER,
  (initial) => {
    let source = replaceOnce(
      initial,
      'async function durablePromptContent(ctx, content) {',
      'async function durablePromptContent(ctx, content, imageFallback) {',
      'durablePromptContent signature',
    );
    source = replaceOnce(
      source,
      `\tfor (const image of images) await ctx.attachments.validateImage({
\t\tdata: image.data,
\t\tmediaType: image.part.mediaType,
\t\t...image.part.name === void 0 ? {} : { name: image.part.name }
\t});
\tconst blocks = [];`,
      `\tfor (const image of images) await ctx.attachments.validateImage({
\t\tdata: image.data,
\t\tmediaType: image.part.mediaType,
\t\t...image.part.name === void 0 ? {} : { name: image.part.name }
\t});
\tconst fallbackDescriptions = new Map();
\tif (imageFallback !== void 0) {
\t\tconst prompt = content.filter((part) => part.type === "text").map((part) => part.text).join("\\n").trim();
\t\tfor (const image of images) fallbackDescriptions.set(image, await imageFallback.describe({
\t\t\tdata: image.data,
\t\t\tmediaType: image.part.mediaType,
\t\t\tprompt
\t\t}));
\t}
\tconst blocks = [];`,
      'local description generation',
    );
    source = replaceOnce(
      source,
      `\t\tblocks.push({
\t\t\ttype: "image",
\t\t\tattachment
\t\t});`,
      `\t\tconst fallbackText = fallbackDescriptions.get(item);
\t\tblocks.push({
\t\t\ttype: "image",
\t\t\tattachment,
\t\t\t...fallbackText === void 0 ? {} : { fallbackText }
\t\t});`,
      'durable fallback text',
    );
    source = replaceOnce(
      source,
      `\t\t\t\tconst hasImage = content.some((part) => part.type === "image");
\t\t\t\tconst admit = async () => {
\t\t\t\t\ttry {
\t\t\t\t\t\tif (hasImage) {
\t\t\t\t\t\t\tconst current = selectionFor(agent).current;
\t\t\t\t\t\t\tconst modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
\t\t\t\t\t\t\tif (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {
\t\t\t\t\t\t\t\tcode: "attachment-error",
\t\t\t\t\t\t\t\tmessage: \`Model "\${current.model}" does not support image input.\`,
\t\t\t\t\t\t\t\tdetails: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
\t\t\t\t\t\t\t});
\t\t\t\t\t\t}
\t\t\t\t\t\tconst message = createUserMessage({
\t\t\t\t\t\t\tcontent: await durablePromptContent(ctx, content),`,
      `\t\t\t\tconst hasImage = content.some((part) => part.type === "image");
\t\t\t\tconst admit = async () => {
\t\t\t\t\ttry {
\t\t\t\t\t\tlet imageFallback;
\t\t\t\t\t\tif (hasImage) {
\t\t\t\t\t\t\tconst current = selectionFor(agent).current;
\t\t\t\t\t\t\tconst modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
\t\t\t\t\t\t\tif (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) {
\t\t\t\t\t\t\t\timageFallback = ctx.get("localVision");
\t\t\t\t\t\t\t\tif (imageFallback === void 0) return err(request, {
\t\t\t\t\t\t\t\t\tcode: "attachment-error",
\t\t\t\t\t\t\t\t\tmessage: \`Model "\${current.model}" does not support image input.\`,
\t\t\t\t\t\t\t\t\tdetails: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
\t\t\t\t\t\t\t\t});
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t\tconst message = createUserMessage({
\t\t\t\t\t\t\tcontent: await durablePromptContent(ctx, content, imageFallback),`,
      'session.prompt local fallback',
    );
    return source;
  },
);

patchFile(
  'node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js',
  BRAND_SIDEBAR_MARKER,
  source => replaceOnce(
    source,
    'children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.BrandWordmark, {})',
    `children: (0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tstyle: {
\t\t\t\t\t\t\t\tfontSize: 17,
\t\t\t\t\t\t\t\tfontWeight: 750,
\t\t\t\t\t\t\t\tletterSpacing: "-0.03em",
\t\t\t\t\t\t\t\twhiteSpace: "nowrap"
\t\t\t\t\t\t\t},
\t\t\t\t\t\t\tchildren: "deep seek yu"
\t\t\t\t\t\t})`,
    'Harness sidebar brand',
  ),
);

patchFile(
  'node_modules/@deepseek-ai/dsh-web-app/lib/index.js',
  BRAND_RUNTIME_MARKER,
  (source) => {
    const branded = source.replaceAll('DeepSeek Harness Web GUI', 'deep seek yu Web GUI');
    if (branded === source) throw new Error('Harness runtime brand target changed.');
    return branded;
  },
);

replaceTextFile(
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  '<title>DeepSeek Harness</title>',
  '<title>deep seek yu</title>',
  'Harness document title',
);

replaceTextFile(
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/manifest.webmanifest',
  '"name": "DeepSeek Harness",\n  "short_name": "DSH"',
  '"name": "deep seek yu",\n  "short_name": "deep seek yu"',
  'Harness PWA manifest brand',
);

patchFile(
  'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js',
  ADAPTER_MARKER,
  (initial) => {
    let source = replaceOnce(
      initial,
      `function flattenText(blocks) {
\treturn blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}`,
      `function flattenText(blocks) {
\treturn blocks.map((block) => {
\t\tif (block.type === "text") return block.text;
\t\tif (block.type === "image" && typeof block.fallbackText === "string" && block.fallbackText.trim() !== "") {
\t\t\treturn \`\\n<local_image_description>\\n\${block.fallbackText.trim()}\\n</local_image_description>\\n\`;
\t\t}
\t\treturn "";
\t}).join("");
}`,
      'DeepSeek flattenText',
    );
    source = replaceOnce(
      source,
      `function assertTextOnly(blocks) {
\tif (contentHasImage(blocks)) throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
}`,
      `function assertTextOnly(blocks) {
\tfor (const block of blocks) {
\t\tif (block.type === "image" && (typeof block.fallbackText !== "string" || block.fallbackText.trim() === "")) {
\t\t\tthrow new LlmError("The DeepSeek chat-completions adapter does not support image content without a local description.", "UNSUPPORTED_CONTENT");
\t\t}
\t\tif (block.type === "tool-result") assertTextOnly(block.content);
\t}
}`,
      'DeepSeek image assertion',
    );
    return source;
  },
);

patchFile(
  'node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts',
  TYPES_MARKER,
  source => replaceOnce(
    source,
    `export interface ImageBlock {
    type: 'image';
    /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
    attachment: ImageAttachmentRef;
}`,
    `export interface ImageBlock {
    type: 'image';
    /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
    attachment: ImageAttachmentRef;
    /** Durable local description used only by text-only model adapters. */
    fallbackText?: string;
}`,
    'ImageBlock fallbackText type',
  ),
);
