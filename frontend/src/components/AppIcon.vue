<template>
    <svg class="icon" aria-hidden="true">
        <use :href="`#i-${name}`" />
    </svg>
</template>

<script setup>
defineProps({
    name: {
        type: String,
        required: true
    }
})
</script>
