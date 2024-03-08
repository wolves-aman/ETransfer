import {createApp} from 'vue'
import App from './App.vue'

import PrimeVue from 'primevue/config';
import Ripple from 'primevue/ripple';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';

import 'primevue/resources/themes/aura-light-green/theme.css'
import 'primevue/resources/primevue.min.css';
import "primeflex/primeflex.css";
import 'primeicons/primeicons.css';
import Button from "primevue/button";

import Tooltip from 'primevue/tooltip';

const app = createApp(App);

app.use(PrimeVue, {
    ripple: true,
    unstyled: false,

})
app.use(ConfirmationService);
app.use(ToastService);
app.directive('ripple', Ripple);
app.directive('tooltip', Tooltip);
app.component('Button', Button);
app.mount('#app')
