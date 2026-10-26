import {defineConfig} from 'vite';
export default defineConfig({build:{rollupOptions:{input:{main:'index.html',rackStyle:'rack-style.html',liveFloor:'live-floor.html'}}}});
