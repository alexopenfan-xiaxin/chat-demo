import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { purgeLegacyApiKey } from './services/settings.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
// 老版本把用户填的明文 key 存在 localStorage，链路已经不需要它了，进页面就清掉
purgeLegacyApiKey()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
