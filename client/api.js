// HTTP 层：URL 拼装、图片地址、JSON 请求。不碰 React。
import { describe } from './state.js'
export function apiUrl(api, path, params) {
  const query = params === undefined || params === null
    ? ''
    : Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      .join('&')
  return api + path + (query === '' ? '' : '?' + query)
}

export function imageSrc(api, image) {
  return apiUrl(api, '/image', {
    filename: image?.filename ?? '',
    subfolder: image?.subfolder ?? '',
    type: image?.type ?? 'output',
  })
}

/** 所有请求的唯一出口：网络错、非 2xx、坏 JSON 都变成可读结果，面板只负责显示。 */
export async function requestJson(url, init) {
  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    return { ok: false, status: 0, payload: null, message: describe(error) }
  }
  let payload = null
  try {
    payload = await response.json()
  } catch (error) {
    payload = null
  }
  if (!response.ok) {
    const message = String(payload?.message ?? payload?.error ?? 'HTTP ' + response.status)
    return { ok: false, status: response.status, payload, message }
  }
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, status: response.status, payload: null, message: 'bad-json' }
  }
  return { ok: true, status: response.status, payload, message: '' }
}

// 参考图走 base64 上传：/upload 只收 JSON，不接 multipart
export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('read-failed'))
    reader.readAsDataURL(file)
  })
}
