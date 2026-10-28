import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import bash from 'highlight.js/lib/languages/bash'
import python from 'highlight.js/lib/languages/python'
import plaintext from 'highlight.js/lib/languages/plaintext'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('text', plaintext)

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer nofollow')
    }
})

marked.use({
    gfm: true,
    breaks: true,
    renderer: {
        code(code, lang) {
            const language = lang && hljs.getLanguage(lang) ? lang : ''
            let highlighted
            try {
                highlighted = language
                    ? hljs.highlight(code, { language }).value
                    : hljs.highlightAuto(code).value
            } catch {
                highlighted = escapeHtml(code)
            }
            const label = escapeHtml(language || lang || 'code')
            return `<div class="md-code"><div class="md-code-head"><span>${label}</span></div><pre><code class="hljs">${highlighted}</code></pre></div>`
        }
    }
})

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/i

export function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export function renderMarkdown(text = '') {
    const source = String(text).slice(0, 20000)
    if (!source.trim()) return ''
    const html = marked.parse(source)
    return DOMPurify.sanitize(html, {
        ADD_ATTR: ['target', 'rel'],
        FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button']
    })
}

export function findFirstUrl(text = '') {
    const match = String(text).match(URL_PATTERN)
    if (!match) return ''
    return match[1].replace(/[),.;!?]+$/, '')
}

export function stripMarkdown(text = '') {
    return String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[#>*_~-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}
