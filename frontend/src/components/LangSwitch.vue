<template>
    <button class="lang-switch" type="button" :aria-label="locale === 'zh' ? 'Switch to English' : '切换到中文'" @click="toggleLocale">
        <span>{{ locale === 'zh' ? 'EN' : '中' }}</span>
    </button>
</template>

<script setup>
import { locale, toggleLocale } from '../lib/i18n'
</script>
