<template>
    <div class="flex flex-column justify-content-center align-items-center" style="height:calc(100vh - 70px)">
        <div v-show="hint" class="hint block text-2xl text-400 mb-5">{{hint}}</div>
        <Button style="width: 80px" label="返回" @click="callback"/>
    </div>
</template>

<script>
export default {
    name: "Error",
    data() {
        return {};
    },
    props:{
        hint:{}
    },
    emits:["update:callback"],
    created() {
    },
    methods: {
        callback() {
            this.$emit("update:callback")
        }
    }
}
</script>

<style scoped>

</style>
