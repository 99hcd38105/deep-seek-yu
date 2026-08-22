import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_MARKER = 'deepseek-harness-local-vision-host-v1';
const ADAPTER_MARKER = 'deepseek-harness-local-vision-adapter-v1';
const TYPES_MARKER = 'deepseek-harness-local-vision-types-v1';
const LLM_CORE_MARKER = 'deepseek-harness-local-vision-projection-v1';
const BRAND_SIDEBAR_MARKER = 'deep-seek-yu-sidebar-brand-v1';
const BRAND_RUNTIME_MARKER = 'deep-seek-yu-runtime-brand-v1';
const BRAND_OFFICIAL_MARKER = 'deep-seek-yu-official-brand-v1';
const BRAND_DOCUMENT_MARKER = 'deep-seek-yu-document-title-v1';

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
      `\tconst refs = await admitEncodedImages(ctx.attachments, content.filter((part) => part.type === "image"));
\tlet next = 0;
\treturn content.map((part) => part.type === "text" ? {
\t\ttype: "text",
\t\ttext: part.text
\t} : {
\t\ttype: "image",
\t\tattachment: refs[next++]
\t});`,
      `\tconst images = content.filter((part) => part.type === "image");
\tconst refs = await admitEncodedImages(ctx.attachments, images);
\tconst fallbackDescriptions = [];
\tif (imageFallback !== void 0) {
\t\tconst prompt = content.filter((part) => part.type === "text").map((part) => part.text).join("\\n").trim();
\t\tfor (const image of images) fallbackDescriptions.push(await imageFallback.describe({
\t\t\tdata: Buffer.from(image.data, "base64"),
\t\t\tmediaType: image.mediaType,
\t\t\tprompt
\t\t}));
\t}
\tlet next = 0;
\treturn content.map((part) => {
\t\tif (part.type === "text") return { type: "text", text: part.text };
\t\tconst index = next++;
\t\treturn {
\t\t\ttype: "image",
\t\t\tattachment: refs[index],
\t\t\t...fallbackDescriptions[index] === void 0 ? {} : { fallbackText: fallbackDescriptions[index] }
\t\t};
\t});`,
      'local description generation',
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
    'children: "DSH Local Build"',
    'children: "deep seek yu"',
    'Harness sidebar brand',
  ),
);

patchFile(
  'node_modules/@deepseek-ai/dsh-client-ui-brand-official/lib/client.js',
  BRAND_OFFICIAL_MARKER,
  source => replaceOnce(
    source,
    'return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.BrandWordmark, { includeMark: false });',
    'return (0, react_jsx_runtime.jsx)("span", { style: { fontSize: 17, fontWeight: 750, whiteSpace: "nowrap" }, children: "deep seek yu" });',
    'Harness official brand slot',
  ),
);

patchFile(
  'node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js',
  BRAND_DOCUMENT_MARKER,
  source => replaceOnce(source, 'const productTitle = "DeepSeek Harness";', 'const productTitle = "deep seek yu";', 'Harness live document title'),
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
}
function contentNeedsNativeImage(blocks) {
\tfor (const block of blocks) {
\t\tif (block.type === "image" && (typeof block.fallbackText !== "string" || block.fallbackText.trim() === "")) return true;
\t\tif (block.type === "tool-result" && contentNeedsNativeImage(block.content)) return true;
\t}
\treturn false;
}`,
      'DeepSeek image assertion',
    );
    source = replaceOnce(
      source,
      'const hasImages = options.messages.some((message) => contentHasImage(message.content));',
      'const hasImages = options.messages.some((message) => contentNeedsNativeImage(message.content));',
      'DeepSeek native image detection',
    );
    return source;
  },
);

patchFile(
  'node_modules/@deepseek-ai/dsh-llm/lib/index.js',
  LLM_CORE_MARKER,
  (initial) => {
    let source = replaceOnce(
      initial,
      `function textOnlyImageText(ref) {
\treturn \`[image omitted because this model accepts text only; attachment sha256:\${String(ref.attachmentId).slice(7, 15)}]\`;
}`,
      `function textOnlyImageText(ref) {
\treturn \`[image omitted because this model accepts text only; attachment sha256:\${String(ref.attachmentId).slice(7, 15)}]\`;
}
function localImageFallbackText(block) {
\tif (typeof block.fallbackText !== "string" || block.fallbackText.trim() === "") return void 0;
\treturn \`<local_image_description>\\n\${block.fallbackText.trim()}\\n</local_image_description>\`;
}`,
      'local image fallback projection helper',
    );
    source = replaceOnce(
      source,
      `\t\t\tnext.push({
\t\t\t\ttype: "text",
\t\t\t\ttext: OFFLOADED_IMAGE_TEXT
\t\t\t});`,
      `\t\t\tnext.push({
\t\t\t\ttype: "text",
\t\t\t\ttext: localImageFallbackText(block) ?? OFFLOADED_IMAGE_TEXT
\t\t\t});`,
      'request image fallback projection',
    );
    source = replaceOnce(
      source,
      `\t\t\tnext.push({
\t\t\t\ttype: "text",
\t\t\t\ttext: textOnlyImageText(block.attachment)
\t\t\t});`,
      `\t\t\tnext.push({
\t\t\t\ttype: "text",
\t\t\t\ttext: localImageFallbackText(block) ?? textOnlyImageText(block.attachment)
\t\t\t});`,
      'text-only image fallback projection',
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
