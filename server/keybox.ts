/**
 * 用户上游 key 的加解密。
 *
 * 明文只在注册那一刻存在于内存里，库里只落 AES-GCM 密文；主密钥走 Pages secret
 * `KEY_ENC_SECRET`，不写文件、不进日志、不回给浏览器。proxy 需要明文转发聊天时，
 * 由 introspect（带共享内部头）解密后下发，别的路径一律解不出。
 */

const encoder = new TextEncoder()

const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (const byte of bytes) {
    out += String.fromCharCode(byte)
  }
  return btoa(out)
}

const fromBase64 = (text: string): Uint8Array => {
  const raw = atob(text)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i)
  }
  return bytes
}

/**
 * 主密钥固定派生自 KEY_ENC_SECRET：同一个 secret 换哪台机器都能解，secret 变了就全解不开，
 * 所以它必须和密文一起进 /root/.secrets/pages.env 的备份。
 */
const deriveKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(secret)), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])

/** 密文格式：base64(iv(12) || ciphertext) */
export const encryptSecret = async (plain: string, secret: string): Promise<string> => {
  const key = await deriveKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plain))
  const packed = new Uint8Array(iv.length + cipher.byteLength)
  packed.set(iv)
  packed.set(new Uint8Array(cipher), iv.length)
  return toBase64(packed)
}

export const decryptSecret = async (stored: string, secret: string): Promise<string | null> => {
  try {
    const packed = fromBase64(stored)
    if (packed.length <= 12) {
      return null
    }
    const key = await deriveKey(secret)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: packed.slice(0, 12) },
      key,
      packed.slice(12)
    )
    return new TextDecoder().decode(plain)
  } catch {
    // 主密钥换过或密文坏了：当作没有，让调用方走「额度读不到」，不要 500
    return null
  }
}
