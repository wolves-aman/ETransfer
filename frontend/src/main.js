import { createApp } from 'vue'
import App from './App.vue'
import './styles/theme.css'
import './styles/app.css'

createApp(App).mount('#app')

if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register(`${process.env.BASE_URL}sw.js`, { scope: process.env.BASE_URL })
            .catch(() => {
                // 静态托管在非安全上下文时注册会失败，不影响主功能
            })
    })
}
