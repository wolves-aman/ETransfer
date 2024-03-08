<template>
    <header class="flex align-items-center py-0 px-3 w-full z-2 px-5">
        <a>
            <svg height="32" viewBox="0 0 90 19" fill="#f00" xmlns="http://www.w3.org/2000/svg">
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
        </a>

        <div class="ml-auto border-0 p-0 m-0 flex">
            <a href="https://www.194nb.com/" target="_blank" class="mr-3 p-link border-1 hover:border-primary  text-600 hover:text-primary w-2rem h-2rem border-300 border-round flex align-items-center justify-content-center">
                <i class="pi pi-user" v-tooltip="'作者博客'"></i>
            </a>
            <a href="https://github.com/wolves-aman/ETransfer" target="_blank" class=" p-link border-1 hover:border-primary text-600 hover:text-primary w-2rem h-2rem border-300 border-round flex align-items-center justify-content-center">
                <i class="pi pi-github" v-tooltip="'github'"></i>
            </a>
        </div>
    </header>
</template>

<script>
export default {
    name: "Header",
    components: {},
    data() {
        return {};
    },
    created() {
    },
    methods: {}
}
</script>

<style scoped>
a{
    text-decoration: none;
}
</style>
