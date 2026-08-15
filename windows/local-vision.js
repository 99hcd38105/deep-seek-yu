const fs = require('node:fs');
const path = require('node:path');

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const MODEL_LABEL = 'SmolVLM 256M（本地轻量模型）';
const REQUIRED_MODEL_FILES = [
  'config.json',
  'preprocessor_config.json',
  'processor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  path.join('onnx', 'decoder_model_merged_q4.onnx'),
  path.join('onnx', 'embed_tokens_q4.onnx'),
  path.join('onnx', 'vision_encoder_q4.onnx'),
];

function directorySize(directory) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(filename);
    else if (entry.isFile()) {
      try { total += fs.statSync(filename).size; } catch {}
    }
  }
  return total;
}

function parseProxyRule(value) {
  for (const rule of String(value || '').split(';')) {
    const match = /^\s*(?:PROXY|HTTPS?)\s+([^\s]+)\s*$/i.exec(rule);
    if (!match) continue;
    return /^https?:\/\//i.test(match[1]) ? match[1] : `http://${match[1]}`;
  }
  return '';
}

function createLocalVision({ cacheDir, resolveProxy = async () => 'DIRECT', onState = () => {} }) {
  const modelDirectory = path.join(cacheDir, ...MODEL_ID.split('/'));
  let processor = null;
  let model = null;
  let RawImage = null;
  let modelPromise = null;
  let state = {
    status: hasCachedModel() ? 'cached' : 'not-downloaded',
    progress: hasCachedModel() ? 100 : 0,
    error: '',
  };

  function hasCachedModel() {
    return REQUIRED_MODEL_FILES.every((filename) => fs.existsSync(path.join(modelDirectory, filename)));
  }

  function publish(next = {}) {
    state = { ...state, ...next };
    onState(publicState());
  }

  function publicState() {
    const cached = hasCachedModel();
    return {
      modelId: MODEL_ID,
      modelLabel: MODEL_LABEL,
      cacheDir,
      cached,
      ready: Boolean(processor && model),
      status: state.status,
      progress: Math.round(Number(state.progress || 0)),
      error: state.error,
      size: directorySize(modelDirectory),
    };
  }

  async function configureRuntime(transformers) {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    transformers.env.cacheDir = cacheDir;
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = true;
    const proxyRule = await resolveProxy('https://huggingface.co/');
    const proxyUrl = parseProxyRule(proxyRule);
    if (!proxyUrl) return;
    const { ProxyAgent } = await import('undici');
    const dispatcher = new ProxyAgent(proxyUrl);
    transformers.env.fetch = (url, options = {}) => globalThis.fetch(url, { ...options, dispatcher });
  }

  function progressCallback(info) {
    if (info?.status !== 'progress_total') return;
    const progress = Math.max(0, Math.min(100, Number(info.progress || 0)));
    publish({ status: 'downloading', progress, error: '' });
  }

  async function load() {
    if (processor && model && RawImage) return { processor, model, RawImage };
    if (modelPromise) return modelPromise;
    const wasCached = hasCachedModel();
    publish({ status: wasCached ? 'loading' : 'downloading', progress: wasCached ? 100 : 0, error: '' });
    modelPromise = (async () => {
      try {
        const transformers = await import('@huggingface/transformers');
        await configureRuntime(transformers);
        processor = await transformers.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: progressCallback });
        model = await transformers.AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
          dtype: {
            embed_tokens: 'q4',
            vision_encoder: 'q4',
            decoder_model_merged: 'q4',
          },
          device: 'cpu',
          progress_callback: progressCallback,
        });
        RawImage = transformers.RawImage;
        publish({ status: 'ready', progress: 100, error: '' });
        return { processor, model, RawImage };
      } catch (error) {
        processor = null;
        model = null;
        RawImage = null;
        const detail = String(error?.message || error || '未知错误').slice(0, 300);
        publish({ status: 'error', error: detail });
        throw new Error(`本地识图模型准备失败：${detail}。请检查网络或代理后重试。`);
      } finally {
        modelPromise = null;
      }
    })();
    return modelPromise;
  }

  async function analyze(buffer, mimeType) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('图片数据为空。');
    const loaded = await load();
    publish({ status: 'analyzing', progress: 100, error: '' });
    try {
      const image = await loaded.RawImage.fromBlob(new Blob([buffer], { type: mimeType }));
      const messages = [{
        role: 'user',
        content: [
          { type: 'image' },
          {
            type: 'text',
            text: 'Describe this image accurately. Include visible objects, people, layout, interface state, and readable text. If it is an error screenshot, copy the key error message. Do not guess unclear details.',
          },
        ],
      }];
      const prompt = loaded.processor.apply_chat_template(messages, { add_generation_prompt: true });
      const inputs = await loaded.processor(prompt, [image]);
      const output = await loaded.model.generate({ ...inputs, max_new_tokens: 320, do_sample: false });
      const promptLength = inputs.input_ids.dims.at(-1);
      const generated = output.slice(null, [promptLength, null]);
      const description = String(loaded.processor.batch_decode(generated, { skip_special_tokens: true })[0] || '')
        .replace(/^\s*(?:Assistant\s*:\s*)?/i, '').trim();
      if (!description) throw new Error('本地模型没有返回可用的图片描述。');
      publish({ status: 'ready', progress: 100, error: '' });
      return description;
    } catch (error) {
      const detail = String(error?.message || error || '未知错误').slice(0, 300);
      publish({ status: 'error', error: detail });
      throw new Error(`本地识图失败：${detail}`);
    }
  }

  return {
    analyze,
    prepare: load,
    getState: publicState,
    modelDirectory: () => modelDirectory,
  };
}

module.exports = { createLocalVision, MODEL_ID, MODEL_LABEL };
