<template>
    <div class="flex flex-column justify-content-center align-items-center" style="height:calc(100vh - 70px)">
        <div v-show="hint" class="hint block text-2xl text-400 mb-5">{{hint}}</div>
        <ProgressBar mode="indeterminate" style="width:500px;height:10px;max-width: 80%"></ProgressBar>
    </div>
</template>

<script>
import ProgressBar from "primevue/progressbar";

export default {
    name: "Loading",
    components: {ProgressBar},
    props:{
        hint:{}
    },
    data() {
        return {};
    },
    created() {
    },
    methods: {}
}
</script>

<style scoped>

</style>
