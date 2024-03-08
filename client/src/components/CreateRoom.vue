<template>
    <div class="flex flex-column justify-content-center align-items-center" style="height:100%">
        <div class="title">
            <svg height="64" viewBox="0 0 90 19" fill="#f00" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <linearGradient id="paint0_linear_7_2" x1="4.02237" y1="9.46943e-08" x2="8.24281" y2="16.4905"
                                    gradientUnits="userSpaceOnUse">
                        <stop stop-color="var(--primary-500)"></stop>
                        <stop offset="1" stop-color="var(--primary-700)"></stop>
                    </linearGradient>
                </defs>
                <g fill="url(#paint0_linear_7_2)">
                    <text x="0" y="16" font-weight="bold" font-size="18">E</text>
                    <text x="9" y="16" font-weight="bold" font-size="18">Transfer</text>
                </g>
            </svg>
        </div>
        <div class="flex flex-column md:w-25rem">
            <InputText type="text" placeholder="房间号" :maxlength="16" v-model="roomId" class="mb-4"/>
            <Button label="创建房间"  @click="createRoom"/>
        </div>
    </div>
</template>

<script>
import InputText from "primevue/inputtext";
import Button from "primevue/button";

export default {
    name: "CreateRoom",
    components: {
        InputText,
        Button
    },
    props: {
    },
    emits: ["createRoom"],
    data() {
        return {
            roomId: "",
        };
    },

    created() {
    },
    methods: {
        createRoom() {
            this.$emit("createRoom", this.roomId)
        }
    }
}
</script>

<style scoped>
.title {
    display: flex;
    color: var(--primary-600);
    justify-content: center;
    align-items: center;
}

.title svg {
    margin-left: 10px
}
</style>
