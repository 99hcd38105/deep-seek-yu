import fs from 'node:fs';
import path from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { AttachmentError } from '@deepseek-ai/dsh-attachment';
import z from '@deepseek-ai/schemastery';

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const DESCRIPTION_PROMPT = [
  'Describe this image accurately for another AI assistant.',
  'Include visible objects, people, layout, interface state, and readable text.',
  'If it is an error screenshot, copy the key error message.',
  'Do not guess unclear details.',
].join(' ');

function parseProxyRule(value) {
  for (const rule of String(value || '').split(';')) {
    const match = /^\s*(?:PROXY|HTTPS?)\s+([^\s]+)\s*$/i.exec(rule);
    if (!match) continue;
    return /^https?:\/\//i.test(match[1]) ? match[1] : `http://${match[1]}`;
  }
  return '';
}

function failure(error) {
  const detail = String(error?.message || error || '未知错误').slice(0, 300);
  return new AttachmentError(`本地识图失败：${detail}`, 'LOCAL_VISION_FAILED');
}

export default class LocalVision extends Service {
  static Config = z.object({
    cacheDir: z.string().required(),
    proxyRule: z.string(),
  });

  constructor(ctx, config) {
    super(ctx, 'localVision');
    this.cacheDir = path.resolve(config.cacheDir);
    this.proxyRule = config.proxyRule || '';
    this.processor = null;
    this.model = null;
    this.RawImage = null;
    this.loading = null;
  }

  async load() {
    if (this.processor && this.model && this.RawImage) {
      return { processor: this.processor, model: this.model, RawImage: this.RawImage };
    }
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
        const transformers = await import('@huggingface/transformers');
        transformers.env.cacheDir = this.cacheDir;
        transformers.env.allowLocalModels = true;
        transformers.env.allowRemoteModels = true;
        const proxyUrl = parseProxyRule(this.proxyRule);
        if (proxyUrl) {
          const { ProxyAgent } = await import('undici');
          const dispatcher = new ProxyAgent(proxyUrl);
          transformers.env.fetch = (url, options = {}) => globalThis.fetch(url, { ...options, dispatcher });
        }
        this.processor = await transformers.AutoProcessor.from_pretrained(MODEL_ID);
        this.model = await transformers.AutoModelForVision2Seq.from_pretrained(MODEL_ID, {
          dtype: {
            embed_tokens: 'q4',
            vision_encoder: 'q4',
            decoder_model_merged: 'q4',
          },
          device: 'cpu',
        });
        this.RawImage = transformers.RawImage;
        return { processor: this.processor, model: this.model, RawImage: this.RawImage };
      } catch (error) {
        this.processor = null;
        this.model = null;
        this.RawImage = null;
        throw failure(error);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  async describe({ data, mediaType, prompt = '' }) {
    try {
      const loaded = await this.load();
      const image = await loaded.RawImage.fromBlob(new Blob([data], { type: mediaType }));
      const userContext = String(prompt || '').trim();
      const messages = [{
        role: 'user',
        content: [
          { type: 'image' },
          { type: 'text', text: userContext ? `${DESCRIPTION_PROMPT}\nUser request: ${userContext}` : DESCRIPTION_PROMPT },
        ],
      }];
      const modelPrompt = loaded.processor.apply_chat_template(messages, { add_generation_prompt: true });
      const inputs = await loaded.processor(modelPrompt, [image]);
      const output = await loaded.model.generate({ ...inputs, max_new_tokens: 320, do_sample: false });
      const promptLength = inputs.input_ids.dims.at(-1);
      const generated = output.slice(null, [promptLength, null]);
      const description = String(loaded.processor.batch_decode(generated, { skip_special_tokens: true })[0] || '')
        .replace(/^\s*(?:Assistant\s*:\s*)?/i, '')
        .trim();
      if (!description) throw new Error('本地模型没有返回可用的图片描述。');
      return description;
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw failure(error);
    }
  }
}
