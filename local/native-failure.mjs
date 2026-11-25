export function nativeFailure(error) {
  const raw = typeof error?.message === 'string' ? error.message : ''
  const info = error?.codexErrorInfo
  const upstream = info && typeof info === 'object' && Object.values(info).find(value => value && typeof value === 'object')
  const status = upstream?.httpStatusCode
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
  const code = /stream disconnected before completion|error decoding response body|stream ended before|response stream.*(disconnect|eof|closed)/i.test(raw)
    ? 'response_stream_lost'
    : (httpStatus === 429 ? 'rate_limited' : httpStatus ? 'upstream_http_error' : 'native_turn_failed')
  return { code, ...(httpStatus ? { httpStatus } : {}) }
}
