import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  DeepSeekAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'

let resolveRequest
const requestReceived = new Promise((resolve) => {
  resolveRequest = resolve
})

const server = createServer((request, response) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    resolveRequest(JSON.parse(body))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}\n\n')
    response.write('data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":1}}\n\n')
    response.end('data: [DONE]\n\n')
  })
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  const address = server.address()
  assert(address && typeof address !== 'string')

  const adapter = new DeepSeekAdapter({
    options: () => resolveAdapterOptions({
      baseURL: `http://127.0.0.1:${address.port}`,
      thinking: 'disabled',
      reasoningEffort: 'off',
    }),
    resolveApiKey: async () => 'test-key',
    resolveUserId: () => '00000000-0000-4000-8000-000000000001',
  })

  const imageBytesMarker = 'THIS_IMAGE_DATA_MUST_NOT_REACH_DEEPSEEK'
  const fallbackText = '图中是一名蓝发女仆风格的卡通角色。'
  for await (const _chunk of adapter.stream({
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    messages: [{
      role: 'user',
      source: { kind: 'user' },
      content: [{
        type: 'image',
        attachment: {
          kind: 'image',
          id: imageBytesMarker,
          mimeType: 'image/webp',
          width: 474,
          height: 490,
          size: 12345,
        },
        fallbackText,
      }],
    }],
  })) {
    // Drain the stream so the complete provider request is exercised.
  }

  const wireRequest = await requestReceived
  const serialized = JSON.stringify(wireRequest)
  assert.match(serialized, /<local_image_description>/)
  assert.match(serialized, new RegExp(fallbackText))
  assert.doesNotMatch(serialized, new RegExp(imageBytesMarker))
  assert.doesNotMatch(serialized, /image_url|data:image/)
  process.stdout.write('DeepSeek local-vision adapter passed: only the local description reached the provider.\n')
} finally {
  await new Promise(resolve => server.close(resolve))
}
